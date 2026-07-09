package gis.example

import org.slf4j.LoggerFactory
import org.slf4j.MDC
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private val analysisRunnerLogger = LoggerFactory.getLogger(AnalysisJobRunner::class.java)

/**
 * claim 済み分析ジョブを、実行中のハートビート (heartbeat_at の定期更新) 付きで実行する。
 * ハートビートが途絶した running 行はスイープ (sweepStaleAnalysisJobs) が回収するため、
 * 「実行中クラッシュ = 有限時間で再実行 or failed」が保証される (issue #24 の第 3 層)。
 *
 * [onHeartbeat] は SQS consumer が ChangeMessageVisibility の延長を重ねるためのフック。
 * 実行スレッドの MDC に jobId / projectId を載せ、ジョブ単位でログを串刺し検索できるようにする
 */
internal fun Database.executeAnalysisJobWithHeartbeat(
    job: ClaimedAnalysisJob,
    heartbeatIntervalSeconds: Long,
    onHeartbeat: () -> Unit = {}
) {
    val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "analysis-job-heartbeat").apply { isDaemon = true }
    }
    scheduler.scheduleAtFixedRate(
        {
            try {
                heartbeatAnalysisJob(job.id)
                onHeartbeat()
            } catch (exc: Exception) {
                analysisRunnerLogger.warn("Failed to heartbeat analysis job {}", job.id, exc)
            }
        },
        heartbeatIntervalSeconds, heartbeatIntervalSeconds, TimeUnit.SECONDS
    )
    try {
        // executeClaimedAnalysisJob は例外を投げず、失敗時は failed をジョブに記録する
        MDC.putCloseable("jobId", job.id).use {
            MDC.putCloseable("projectId", job.projectId).use {
                executeClaimedAnalysisJob(job)
            }
        }
    } finally {
        scheduler.shutdownNow()
    }
}

// app.analysis_jobs をポーリングして分析ジョブを実行するバックグラウンドランナー (JOB_QUEUE_MODE=polling)。
// dev / 単一ホスト構成の既定。API プロセス内 (ANALYSIS_RUNNER_MODE=in-process) でも
// 独立ワーカープロセス (AnalysisWorkerMain) でも同じ実装を使う。
// claim は FOR UPDATE SKIP LOCKED によるジョブテーブルキュー方式のまま変えていない
class AnalysisJobRunner(
    private val db: Database,
    private val pollIntervalMillis: Long,
    private val staleJobMaxAgeSeconds: Long,
    private val maxAttempts: Int = DEFAULT_JOB_MAX_ATTEMPTS,
    private val heartbeatIntervalSeconds: Long = DEFAULT_HEARTBEAT_INTERVAL_SECONDS
) {
    private val logger = LoggerFactory.getLogger(AnalysisJobRunner::class.java)

    @Volatile
    private var running = false
    private var thread: Thread? = null
    private var nextStaleCheckAtMillis = 0L

    fun start() {
        if (thread != null) return
        running = true
        thread = Thread(::loop, "analysis-job-runner").apply {
            isDaemon = true
            start()
        }
        logger.info("Analysis job runner started (poll interval {} ms)", pollIntervalMillis)
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread = null
    }

    private fun loop() {
        while (running) {
            requeueStaleJobsIfDue()
            val job = try {
                db.claimPendingAnalysisJob()
            } catch (exc: Exception) {
                logger.warn("Failed to claim analysis job", exc)
                null
            }
            if (job == null) {
                try {
                    Thread.sleep(pollIntervalMillis)
                } catch (exc: InterruptedException) {
                    if (!running) return
                }
                continue
            }
            db.executeAnalysisJobWithHeartbeat(job, heartbeatIntervalSeconds)
        }
    }

    // claim はトランザクション単位で確定するため、実行中に落ちたジョブは running のまま残る。
    // ポーリングごとでは無駄が多いので一定間隔でだけハートビート途絶分を回収する
    private fun requeueStaleJobsIfDue() {
        val now = System.currentTimeMillis()
        if (now < nextStaleCheckAtMillis) return
        nextStaleCheckAtMillis = now + STALE_CHECK_INTERVAL_MILLIS
        try {
            val result = db.sweepStaleAnalysisJobs(staleJobMaxAgeSeconds, maxAttempts)
            if (result.requeued > 0 || result.failed > 0) {
                logger.warn(
                    "Swept stale analysis jobs: requeued={}, failed={} (heartbeat timeout {} s)",
                    result.requeued, result.failed, staleJobMaxAgeSeconds
                )
            }
        } catch (exc: Exception) {
            logger.warn("Failed to sweep stale analysis jobs", exc)
        }
    }

    companion object {
        private const val STALE_CHECK_INTERVAL_MILLIS = 60_000L
        const val DEFAULT_JOB_MAX_ATTEMPTS = 5
        const val DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 15L
    }
}
