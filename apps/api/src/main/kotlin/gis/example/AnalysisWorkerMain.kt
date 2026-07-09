// 分析ジョブ実行ワーカーの独立エントリポイント (issue #24)。
//
// API プロセス内デーモンスレッド (ANALYSIS_RUNNER_MODE=in-process) から分離し、
// ECS 上で API と独立にスケールさせるための別バイナリ (gradle installDist の bin/analysis-worker。
// compose では api と同イメージの command 差し替え)。
//
// JOB_QUEUE_MODE で駆動方式が切り替わる:
//   - polling (既定): 従来どおり app.analysis_jobs を DB ポーリング (AnalysisJobRunner)
//   - sqs: SQS の起動通知を long polling で受け、メッセージが指すジョブ行を claim して実行する。
//     実行保証は SQS ではなく DB のジョブ台帳が正 (詳細は docs/jobs-architecture.md)
package gis.example

import org.slf4j.LoggerFactory
import software.amazon.awssdk.services.sqs.SqsClient
import software.amazon.awssdk.services.sqs.model.Message
import java.util.concurrent.CountDownLatch

private val analysisWorkerLogger = LoggerFactory.getLogger("gis.example.AnalysisWorker")

/** 分析ワーカーの設定 (環境変数の一覧と既定値は docs/environment-variables.md) */
data class AnalysisWorkerSettings(
    val pollIntervalMillis: Long,
    val heartbeatIntervalSeconds: Long,
    /** ハートビート途絶とみなす閾値 (秒)。running 行の回収判定 */
    val staleJobMaxAgeSeconds: Long,
    /** claim 試行回数の上限。超過した stale 行は failed 化して収束させる */
    val maxAttempts: Int,
    /** stale 回収 + 補完スキャンの実行間隔 (秒) */
    val sweepIntervalSeconds: Long,
    /** pending のままこの秒数を超えた行を補完スキャンが再 enqueue する (enqueue 取りこぼし回収) */
    val pendingReenqueueSeconds: Long,
    /** SQS long polling の待ち時間 (秒)。スイープ実行のためこの周期でループが回る */
    val receiveWaitSeconds: Int,
    /** ハートビートごとに延長する visibility timeout (秒) */
    val visibilityExtensionSeconds: Int,
    /** テスト専用フック: claim 直後に実行を保留する時間 (kill 回復の統合テストが使う。本番では常に 0) */
    val testClaimHoldMillis: Long
) {
    companion object {
        fun fromEnv(getenv: (String) -> String? = System::getenv) = AnalysisWorkerSettings(
            pollIntervalMillis = ((getenv("ANALYSIS_POLL_INTERVAL_SECONDS") ?: "2").toDouble() * 1000).toLong(),
            heartbeatIntervalSeconds = (getenv("ANALYSIS_JOB_HEARTBEAT_SECONDS") ?: "15").toLong(),
            staleJobMaxAgeSeconds = (getenv("ANALYSIS_JOB_STALE_SECONDS") ?: "1800").toLong(),
            maxAttempts = (getenv("ANALYSIS_JOB_MAX_ATTEMPTS") ?: "5").toInt(),
            sweepIntervalSeconds = (getenv("ANALYSIS_SWEEP_INTERVAL_SECONDS") ?: "60").toLong(),
            pendingReenqueueSeconds = (getenv("ANALYSIS_JOB_REENQUEUE_SECONDS") ?: "300").toLong(),
            receiveWaitSeconds = (getenv("ANALYSIS_RECEIVE_WAIT_SECONDS") ?: "10").toInt(),
            visibilityExtensionSeconds = (getenv("ANALYSIS_VISIBILITY_EXTENSION_SECONDS") ?: "120").toInt(),
            testClaimHoldMillis = (getenv("ANALYSIS_TEST_CLAIM_HOLD_MILLIS") ?: "0").toLong()
        )
    }
}

/**
 * SQS 起動通知の consumer。実行保証の各層との対応:
 *   - 重複配信 → claimAnalysisJobById の失敗 → メッセージ削除のみ (第 2 層: DB claim が正)
 *   - 実行中はハートビート + ChangeMessageVisibility 延長 (第 3 層)
 *   - 実行完了 (succeeded / failed どちらでも収束) 後にメッセージ削除
 *   - sweepNow: ハートビート途絶 running の回収と、pending 滞留の再 enqueue (第 1・5 層)
 *
 * 並列度はプロセス内 1 で固定し、スケールは ECS タスク数 (キュー深度ベースの Auto Scaling) で行う
 */
class SqsAnalysisWorker(
    private val db: Database,
    private val sqs: SqsClient,
    private val queueUrl: String,
    private val settings: AnalysisWorkerSettings
) {
    @Volatile
    private var running = true
    private var nextSweepAtMillis = 0L

    fun stop() {
        running = false
    }

    fun run() {
        analysisWorkerLogger.info("SQS analysis worker started (queue={})", queueUrl)
        while (running) {
            try {
                sweepIfDue()
                pollOnce()
            } catch (exc: Exception) {
                analysisWorkerLogger.warn("Analysis worker loop failed", exc)
                Thread.sleep(settings.pollIntervalMillis)
            }
        }
    }

    /** 1 回の receive → claim → 実行。統合テストが決定的に駆動できるよう public にしている */
    fun pollOnce(): Int {
        val messages = sqs.receiveMessage {
            it.queueUrl(queueUrl)
                .maxNumberOfMessages(1)
                .waitTimeSeconds(settings.receiveWaitSeconds)
        }.messages()
        messages.forEach(::handleMessage)
        return messages.size
    }

    private fun handleMessage(message: Message) {
        val jobId = decodeJobQueueMessage(message.body())
        if (jobId == null) {
            // 解釈できない毒メッセージ。ジョブ行と対応しないため削除して終わり
            analysisWorkerLogger.warn("Dropping malformed analysis queue message: {}", message.body().take(200))
            deleteMessage(message)
            return
        }
        val job = db.claimAnalysisJobById(jobId)
        if (job == null) {
            // at-least-once の重複配信 or 実行済み/実行中/failed 済み。DB のジョブ台帳が正であり、
            // claim できないメッセージに対してすることは何もない (削除のみ = 無害)
            analysisWorkerLogger.info("Analysis job {} is not claimable (duplicate delivery?) — dropping message", jobId)
            deleteMessage(message)
            return
        }
        if (settings.testClaimHoldMillis > 0) {
            // テスト専用フック: 実行中クラッシュを再現するために claim 後の実行を保留する
            Thread.sleep(settings.testClaimHoldMillis)
        }
        db.executeAnalysisJobWithHeartbeat(job, settings.heartbeatIntervalSeconds) {
            extendVisibility(message)
        }
        // succeeded でも failed でもジョブは終端状態に収束済み。メッセージの役目は終わり
        deleteMessage(message)
    }

    /** stale running の回収 (途絶 → pending / 上限超過 → failed) と pending 滞留の再 enqueue */
    fun sweepNow() {
        val result = db.sweepStaleAnalysisJobs(settings.staleJobMaxAgeSeconds, settings.maxAttempts)
        if (result.requeued > 0 || result.failed > 0) {
            analysisWorkerLogger.warn(
                "Swept stale analysis jobs: requeued={}, failed={} (heartbeat timeout {} s)",
                result.requeued, result.failed, settings.staleJobMaxAgeSeconds
            )
        }
        // 補完スキャン (outbox 簡易版): enqueue の取りこぼし・再 pending 化された行へ起動通知を再送する。
        // 重複通知は claim の冪等ガードで無害
        val staleIds = db.listStalePendingAnalysisJobIds(settings.pendingReenqueueSeconds, PENDING_REENQUEUE_BATCH)
        for (id in staleIds) {
            try {
                sqs.sendMessage { it.queueUrl(queueUrl).messageBody(encodeJobQueueMessage(id)) }
            } catch (exc: Exception) {
                analysisWorkerLogger.warn("Failed to re-enqueue stale pending analysis job {}", id, exc)
            }
        }
        if (staleIds.isNotEmpty()) {
            analysisWorkerLogger.warn("Re-enqueued {} stale pending analysis job(s)", staleIds.size)
        }
    }

    private fun sweepIfDue() {
        val now = System.currentTimeMillis()
        if (now < nextSweepAtMillis) return
        nextSweepAtMillis = now + settings.sweepIntervalSeconds * 1000
        try {
            sweepNow()
        } catch (exc: Exception) {
            analysisWorkerLogger.warn("Failed to sweep analysis jobs", exc)
        }
    }

    private fun extendVisibility(message: Message) {
        try {
            sqs.changeMessageVisibility {
                it.queueUrl(queueUrl)
                    .receiptHandle(message.receiptHandle())
                    .visibilityTimeout(settings.visibilityExtensionSeconds)
            }
        } catch (exc: Exception) {
            // 延長失敗 = 再配信が起き得るだけで、二重実行は claim が防ぐ (第 2 層)
            analysisWorkerLogger.warn("Failed to extend message visibility (job message will be redelivered)", exc)
        }
    }

    private fun deleteMessage(message: Message) {
        try {
            sqs.deleteMessage { it.queueUrl(queueUrl).receiptHandle(message.receiptHandle()) }
        } catch (exc: Exception) {
            // 削除失敗は再配信 → claim 失敗 → 削除リトライで収束する
            analysisWorkerLogger.warn("Failed to delete analysis queue message", exc)
        }
    }

    private companion object {
        const val PENDING_REENQUEUE_BATCH = 100
    }
}

fun main() {
    // LOG_FORMAT の不正値は「appender が解決できず無ログで走り続ける」事故になるため先に検証する (api と同じ)
    validateLogFormatEnv()
    val db = Database.fromEnv()
    // Flyway は履歴テーブルのロックで直列化されるため、api と同時に起動しても安全 (冪等)
    db.migrateSchema()
    val settings = AnalysisWorkerSettings.fromEnv()

    when (jobQueueModeFromEnv()) {
        JobQueueMode.POLLING -> {
            val runner = AnalysisJobRunner(
                db = db,
                pollIntervalMillis = settings.pollIntervalMillis,
                staleJobMaxAgeSeconds = settings.staleJobMaxAgeSeconds,
                maxAttempts = settings.maxAttempts,
                heartbeatIntervalSeconds = settings.heartbeatIntervalSeconds
            )
            runner.start()
            analysisWorkerLogger.info("Analysis worker started in polling mode")
            val latch = CountDownLatch(1)
            Runtime.getRuntime().addShutdownHook(
                Thread {
                    runner.stop()
                    db.close()
                    latch.countDown()
                }
            )
            latch.await()
        }
        JobQueueMode.SQS -> {
            val worker = SqsAnalysisWorker(
                db = db,
                sqs = sqsClientFromEnv(),
                queueUrl = requireQueueUrlEnv("SQS_ANALYSIS_QUEUE_URL", System::getenv),
                settings = settings
            )
            Runtime.getRuntime().addShutdownHook(
                Thread {
                    worker.stop()
                    db.close()
                }
            )
            worker.run()
        }
    }
}
