package gis.example

import org.slf4j.LoggerFactory
import org.slf4j.MDC

// app.analysis_jobs をポーリングして分析ジョブを実行するバックグラウンドランナー。
// worker-gis が担っていた分析実行を API プロセスへ移したもので、
// claim は FOR UPDATE SKIP LOCKED によるジョブテーブルキュー方式のまま変えていない
class AnalysisJobRunner(
    private val db: Database,
    private val pollIntervalMillis: Long,
    private val staleJobMaxAgeSeconds: Long
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
            // executeClaimedAnalysisJob は例外を投げず、失敗時は failed をジョブに記録する。
            // ランナースレッドの MDC に jobId / projectId を載せ、実行中の全ログ行を
            // ジョブ単位で串刺し検索できるようにする (HTTP の callId に相当する相関 ID)
            MDC.putCloseable("jobId", job.id).use {
                MDC.putCloseable("projectId", job.projectId).use {
                    db.executeClaimedAnalysisJob(job)
                }
            }
        }
    }

    // claim はトランザクション単位で確定するため、実行中に落ちたジョブは running のまま残る。
    // ポーリングごとでは無駄が多いので一定間隔でだけリース期限超過分を pending へ戻す
    private fun requeueStaleJobsIfDue() {
        val now = System.currentTimeMillis()
        if (now < nextStaleCheckAtMillis) return
        nextStaleCheckAtMillis = now + STALE_CHECK_INTERVAL_MILLIS
        try {
            val requeued = db.requeueStaleAnalysisJobs(staleJobMaxAgeSeconds)
            if (requeued > 0) {
                logger.warn("Requeued {} stale analysis job(s) running longer than {} seconds", requeued, staleJobMaxAgeSeconds)
            }
        } catch (exc: Exception) {
            logger.warn("Failed to requeue stale analysis jobs", exc)
        }
    }

    private companion object {
        const val STALE_CHECK_INTERVAL_MILLIS = 60_000L
    }
}
