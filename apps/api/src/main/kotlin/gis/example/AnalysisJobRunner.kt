package gis.example

import org.slf4j.LoggerFactory

// app.analysis_jobs をポーリングして分析ジョブを実行するバックグラウンドランナー。
// worker-gis が担っていた分析実行を API プロセスへ移したもので、
// claim は FOR UPDATE SKIP LOCKED によるジョブテーブルキュー方式のまま変えていない
class AnalysisJobRunner(
    private val db: Database,
    private val pollIntervalMillis: Long
) {
    private val logger = LoggerFactory.getLogger(AnalysisJobRunner::class.java)

    @Volatile
    private var running = false
    private var thread: Thread? = null

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
            // executeClaimedAnalysisJob は例外を投げず、失敗時は failed をジョブに記録する
            db.executeClaimedAnalysisJob(job)
        }
    }
}
