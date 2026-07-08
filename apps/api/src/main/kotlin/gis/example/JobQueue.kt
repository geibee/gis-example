// ジョブディスパッチの SQS 化 (issue #24)。
//
// ジョブの正本はあくまで Postgres のジョブ行 (app.analysis_jobs / app.import_jobs) であり、
// SQS メッセージは「pending 行ができた」という起動通知に限定する (キューと DB の二重正本化を避ける)。
// したがって:
//   - enqueue の失敗はジョブ作成のエラーにしない (補完スキャンが pending 行を再 enqueue して回収する)
//   - メッセージの重複・消失があっても、実行開始の正は DB の SKIP LOCKED claim (AnalysisJobQueries.kt)
//
// JOB_QUEUE_MODE=polling (既定) では何も送らない (従来どおり各ワーカーが DB をポーリングする)。
package gis.example

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.sqs.SqsClient
import java.net.URI

private val jobQueueLogger = LoggerFactory.getLogger("gis.example.JobQueue")

private val jobQueueJson = Json { ignoreUnknownKeys = true }

/** SQS メッセージ本文。ジョブ行の内容は運ばず、起動通知として jobId のみを持つ */
@Serializable
data class JobQueueMessage(val jobId: String)

fun encodeJobQueueMessage(jobId: String): String = jobQueueJson.encodeToString(JobQueueMessage(jobId))

/** メッセージ本文から jobId を取り出す。解釈できない毒メッセージは null (呼び出し側が削除する) */
fun decodeJobQueueMessage(body: String): String? = try {
    jobQueueJson.decodeFromString<JobQueueMessage>(body).jobId.takeIf { it.isNotBlank() }
} catch (_: SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

enum class JobQueueMode { POLLING, SQS }

fun jobQueueModeFromEnv(getenv: (String) -> String? = System::getenv): JobQueueMode =
    when (val raw = getenv("JOB_QUEUE_MODE")?.trim()?.lowercase() ?: "polling") {
        "polling" -> JobQueueMode.POLLING
        "sqs" -> JobQueueMode.SQS
        // 不正値でポーリングへ黙って落ちると「enqueue されないのに consumer は SQS を見る」
        // 片肺構成になり得るため fail fast (validateLogFormatEnv と同じ方針)
        else -> error("JOB_QUEUE_MODE は polling | sqs のいずれかを指定してください: $raw")
    }

/**
 * SQS クライアント。認証は AWS SDK の既定チェーン (本番: ECS タスクロール / dev: 環境変数)。
 * SQS_ENDPOINT_URL は ElasticMQ 等の dev 用エンドポイント上書き (本番では設定しない)
 */
fun sqsClientFromEnv(getenv: (String) -> String? = System::getenv): SqsClient {
    val builder = SqsClient.builder()
    getenv("SQS_REGION")?.takeIf { it.isNotBlank() }?.let { builder.region(Region.of(it)) }
    getenv("SQS_ENDPOINT_URL")?.takeIf { it.isNotBlank() }?.let { builder.endpointOverride(URI.create(it)) }
    return builder.build()
}

/** API がジョブ行の INSERT コミット後に呼ぶ起動通知。実装はモード (polling | sqs) で切り替わる */
interface JobDispatcher : AutoCloseable {
    fun notifyAnalysisJob(jobId: String)
    fun notifyImportJob(jobId: String)
    override fun close() {}
}

/** polling モード: 通知しない (ワーカーの DB ポーリングが拾う従来動作) */
object NoopJobDispatcher : JobDispatcher {
    override fun notifyAnalysisJob(jobId: String) {}
    override fun notifyImportJob(jobId: String) {}
}

/**
 * sqs モード: 分析 / 取込それぞれのキューへ起動通知を送る。
 * 送信失敗は WARN ログのみでエラーにしない (ジョブ行が正本。補完スキャンが回収する)
 */
class SqsJobDispatcher(
    private val client: SqsClient,
    private val analysisQueueUrl: String,
    private val importQueueUrl: String
) : JobDispatcher {
    override fun notifyAnalysisJob(jobId: String) = send(analysisQueueUrl, jobId)

    override fun notifyImportJob(jobId: String) = send(importQueueUrl, jobId)

    private fun send(queueUrl: String, jobId: String) {
        try {
            client.sendMessage { it.queueUrl(queueUrl).messageBody(encodeJobQueueMessage(jobId)) }
        } catch (exc: Exception) {
            jobQueueLogger.warn(
                "Failed to enqueue job notification (jobId={}, queue={}) — 補完スキャンが回収します",
                jobId, queueUrl, exc
            )
        }
    }

    override fun close() {
        client.close()
    }
}

fun requireQueueUrlEnv(name: String, getenv: (String) -> String?): String =
    getenv(name)?.takeIf { it.isNotBlank() }
        ?: error("JOB_QUEUE_MODE=sqs では $name が必須です (docs/environment-variables.md)")

/** API 側のディスパッチャ組み立て。sqs モードでキュー URL 未設定なら起動失敗 (fail fast) */
fun jobDispatcherFromEnv(getenv: (String) -> String? = System::getenv): JobDispatcher =
    when (jobQueueModeFromEnv(getenv)) {
        JobQueueMode.POLLING -> NoopJobDispatcher
        JobQueueMode.SQS -> {
            // キュー URL の検証をクライアント生成より先に行う (設定不備は必ず起動失敗にする)
            val analysisQueueUrl = requireQueueUrlEnv("SQS_ANALYSIS_QUEUE_URL", getenv)
            val importQueueUrl = requireQueueUrlEnv("SQS_IMPORT_QUEUE_URL", getenv)
            SqsJobDispatcher(sqsClientFromEnv(getenv), analysisQueueUrl, importQueueUrl)
        }
    }
