package gis.example

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

// SQS 起動通知メッセージの契約 (encode/decode) とモード解決の単体テスト。
// メッセージ本文は worker-gis (worker.py の decode_job_message) と共有する契約のため、
// 形を変えるときは両側のテストを更新すること
class JobQueueTest {

    @Test
    fun `メッセージは jobId を運び ラウンドトリップできる`() {
        val body = encodeJobQueueMessage("6b1f0000-0000-0000-0000-000000000024")
        assertEquals("""{"jobId":"6b1f0000-0000-0000-0000-000000000024"}""", body)
        assertEquals("6b1f0000-0000-0000-0000-000000000024", decodeJobQueueMessage(body))
    }

    @Test
    fun `解釈できない本文は null (毒メッセージとして削除される)`() {
        assertNull(decodeJobQueueMessage("not-json"))
        assertNull(decodeJobQueueMessage("{}"))
        assertNull(decodeJobQueueMessage("""{"jobId":""}"""))
        assertNull(decodeJobQueueMessage("""[1,2,3]"""))
    }

    @Test
    fun `未知フィールドは無視して jobId を読む (前方互換)`() {
        assertEquals("abc", decodeJobQueueMessage("""{"jobId":"abc","futureField":1}"""))
    }

    @Test
    fun `JOB_QUEUE_MODE は polling 既定で 不正値は起動失敗`() {
        assertEquals(JobQueueMode.POLLING, jobQueueModeFromEnv { null })
        assertEquals(JobQueueMode.POLLING, jobQueueModeFromEnv { "polling" })
        assertEquals(JobQueueMode.SQS, jobQueueModeFromEnv { "sqs" })
        assertFailsWith<IllegalStateException> { jobQueueModeFromEnv { "kafka" } }
    }

    @Test
    fun `sqs モードでキュー URL 未設定なら fail fast`() {
        assertFailsWith<IllegalStateException> {
            jobDispatcherFromEnv { name -> if (name == "JOB_QUEUE_MODE") "sqs" else null }
        }
    }

    @Test
    fun `polling モードのディスパッチャは no-op`() {
        val dispatcher = jobDispatcherFromEnv { name -> if (name == "JOB_QUEUE_MODE") "polling" else null }
        assertEquals(NoopJobDispatcher, dispatcher)
        dispatcher.notifyAnalysisJob("x")
        dispatcher.notifyImportJob("y")
    }
}
