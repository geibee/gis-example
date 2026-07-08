package gis.example.integration

import gis.example.AnalysisJobRequest
import gis.example.AnalysisWorkerSettings
import gis.example.ConditionQueryConditionDto
import gis.example.ConditionQueryDto
import gis.example.Database
import gis.example.SqsAnalysisWorker
import gis.example.SqsJobDispatcher
import gis.example.createAnalysisJob
import gis.example.encodeJobQueueMessage
import gis.example.getAnalysisJob
import gis.example.sweepStaleAnalysisJobs
import kotlinx.serialization.json.JsonPrimitive
import org.elasticmq.rest.sqs.SQSRestServer
import org.elasticmq.rest.sqs.SQSRestServerBuilder
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.Timeout
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.sqs.SqsClient
import software.amazon.awssdk.services.sqs.model.QueueAttributeName
import java.net.ServerSocket
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

// SQS 経路 (JOB_QUEUE_MODE=sqs) の統合テスト (issue #24)。
// PostGIS に加え、SQS はテスト JVM 内に埋め込んだ使い捨て ElasticMQ で立てる
// (CI の api-integration ジョブは PostGIS しか持たないため自己完結させる)。
//
// 検証対象は実行保証の各層:
//   - enqueue → consume → claim → succeeded の基本経路と enqueue 失敗の無害性 (第 1 層)
//   - 同一メッセージの二重配信が claim の冪等ガードで無害なこと (第 2 層)
//   - 実行中の強制 kill (独立ワーカープロセスを SIGKILL) から別 worker が回収し、
//     二重実行なしに収束すること (第 3 層)
//   - 試行上限超過の failed 化と pending 滞留の再 enqueue (第 5 層)
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JobQueueSqsIntegrationTest {

    private val projectId = "00000000-0000-0000-0000-000000000000"
    private val parcelsLayerId = "11111111-1111-1111-1111-111111111111"

    private lateinit var db: Database
    private lateinit var elasticMq: SQSRestServer
    private lateinit var sqs: SqsClient
    private var sqsPort: Int = 0
    private var queueSequence = 0

    private fun rawConnection(): Connection =
        DriverManager.getConnection(IntegrationDb.url, IntegrationDb.user, IntegrationDb.password)

    private fun repoFile(relative: String): String {
        var dir = Path.of("").toAbsolutePath()
        while (!Files.exists(dir.resolve(".git"))) {
            dir = dir.parent ?: fail("リポジトリルートが見つかりません")
        }
        return Files.readString(dir.resolve(relative))
    }

    @BeforeAll
    fun setUp() {
        rawConnection().use { connection ->
            connection.createStatement().use { stmt ->
                stmt.execute("DROP SCHEMA IF EXISTS app CASCADE")
                stmt.execute("DROP SCHEMA IF EXISTS gis_data CASCADE")
            }
            connection.createStatement().use { stmt ->
                stmt.execute(repoFile("infra/postgres/init.sql"))
            }
            IntegrationDb.migrate()
            val fixture = this::class.java.getResource("/integration-fixture.sql")
                ?: fail("integration-fixture.sql がテストリソースにありません")
            connection.createStatement().use { stmt ->
                stmt.execute(fixture.readText())
            }
        }
        db = Database.fromEnv()

        sqsPort = ServerSocket(0).use { it.localPort }
        elasticMq = SQSRestServerBuilder.withPort(sqsPort).withInterface("localhost").start()
        elasticMq.waitUntilStarted()
        sqs = SqsClient.builder()
            .region(Region.US_EAST_1)
            .endpointOverride(URI.create("http://localhost:$sqsPort"))
            .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("test", "test")))
            .build()
    }

    @AfterAll
    fun tearDown() {
        sqs.close()
        elasticMq.stopAndWait()
        db.close()
    }

    // ---------------------------------------------------------------- ヘルパ

    /** テストごとに独立したキュー (visibility timeout は再配信テストを速く回すため 2 秒) */
    private fun createQueue(): String = sqs.createQueue {
        it.queueName("analysis-jobs-${queueSequence++}")
            .attributes(mapOf(QueueAttributeName.VISIBILITY_TIMEOUT to "2"))
    }.queueUrl()

    private fun workerSettings(
        staleSeconds: Long = 1800,
        reenqueueSeconds: Long = 300,
        maxAttempts: Int = 5
    ) = AnalysisWorkerSettings(
        pollIntervalMillis = 100,
        heartbeatIntervalSeconds = 1,
        staleJobMaxAgeSeconds = staleSeconds,
        maxAttempts = maxAttempts,
        sweepIntervalSeconds = 1,
        pendingReenqueueSeconds = reenqueueSeconds,
        receiveWaitSeconds = 1,
        visibilityExtensionSeconds = 3,
        testClaimHoldMillis = 0
    )

    private fun analysisRequest(name: String) = AnalysisJobRequest(
        projectId = projectId,
        name = name,
        operation = "condition_search",
        conditionQuery = ConditionQueryDto(
            projectId = projectId,
            targetLayerIds = listOf(parcelsLayerId),
            conditions = listOf(
                ConditionQueryConditionDto(
                    type = "attribute",
                    field = "zoning_name",
                    operator = "=",
                    value = JsonPrimitive("商業地域")
                )
            ),
            limit = 100
        )
    )

    private fun sendNotification(queueUrl: String, jobId: String) {
        sqs.sendMessage { it.queueUrl(queueUrl).messageBody(encodeJobQueueMessage(jobId)) }
    }

    private fun attemptCount(jobId: String): Int = rawConnection().use { connection ->
        connection.prepareStatement("SELECT attempt_count FROM app.analysis_jobs WHERE id = ?::uuid").use { stmt ->
            stmt.setString(1, jobId)
            stmt.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
    }

    /** 結果レイヤの登録数。結果テーブル名はジョブ ID から決定的なため、二重実行されると 2 件になる */
    private fun resultLayerCount(jobId: String): Int = rawConnection().use { connection ->
        connection.prepareStatement("SELECT count(*) FROM app.layers WHERE table_name LIKE ?").use { stmt ->
            stmt.setString(1, "result_${jobId.replace("-", "").take(24)}%")
            stmt.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
    }

    private fun queueIsEmpty(queueUrl: String): Boolean {
        val attrs = sqs.getQueueAttributes {
            it.queueUrl(queueUrl).attributeNames(
                QueueAttributeName.APPROXIMATE_NUMBER_OF_MESSAGES,
                QueueAttributeName.APPROXIMATE_NUMBER_OF_MESSAGES_NOT_VISIBLE
            )
        }.attributes()
        return attrs[QueueAttributeName.APPROXIMATE_NUMBER_OF_MESSAGES] == "0" &&
            attrs[QueueAttributeName.APPROXIMATE_NUMBER_OF_MESSAGES_NOT_VISIBLE] == "0"
    }

    private fun waitFor(timeoutMillis: Long, message: String, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMillis
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(200)
        }
        fail("タイムアウト (${timeoutMillis}ms): $message")
    }

    // ---------------------------------------------------------------- 基本経路 (第 1 層)

    @Test
    @Timeout(120)
    fun `SQS 起動通知で enqueue - consume - claim - succeeded に収束する`() {
        val queueUrl = createQueue()
        val job = db.createAnalysisJob(analysisRequest("SQS 基本経路"))
        SqsJobDispatcher(sqs, queueUrl, queueUrl).notifyAnalysisJob(job.id)

        val worker = SqsAnalysisWorker(db, sqs, queueUrl, workerSettings())
        assertEquals(1, worker.pollOnce(), "起動通知を 1 件 consume するはず")

        val finished = assertNotNull(db.getAnalysisJob(job.id))
        assertEquals("succeeded", finished.status, "error: ${finished.errorMessage}")
        assertEquals(1, attemptCount(job.id))
        assertEquals(1, resultLayerCount(job.id))
        assertTrue(queueIsEmpty(queueUrl), "処理完了後はメッセージが削除されるはず")
    }

    @Test
    @Timeout(120)
    fun `enqueue の失敗はジョブ作成を失敗させず 補完スキャンが回収する`() {
        val queueUrl = createQueue()
        val job = db.createAnalysisJob(analysisRequest("enqueue 消失の回収"))
        // 存在しないキューへの enqueue = 送信失敗。notify は例外を投げない (ジョブ行が正本)
        SqsJobDispatcher(sqs, "http://localhost:$sqsPort/000000000000/no-such-queue", queueUrl)
            .notifyAnalysisJob(job.id)
        assertEquals("pending", assertNotNull(db.getAnalysisJob(job.id)).status)

        // pending 滞留を再現し、補完スキャン → consume で収束させる
        rawConnection().use { connection ->
            connection.prepareStatement(
                "UPDATE app.analysis_jobs SET created_at = now() - interval '10 minutes' WHERE id = ?::uuid"
            ).use { stmt ->
                stmt.setString(1, job.id)
                stmt.executeUpdate()
            }
        }
        val worker = SqsAnalysisWorker(db, sqs, queueUrl, workerSettings(reenqueueSeconds = 1))
        worker.sweepNow()
        assertEquals(1, worker.pollOnce(), "補完スキャンが再 enqueue した通知を consume するはず")

        val finished = assertNotNull(db.getAnalysisJob(job.id))
        assertEquals("succeeded", finished.status, "error: ${finished.errorMessage}")
    }

    // ---------------------------------------------------------------- 二重配信 (第 2 層)

    @Test
    @Timeout(120)
    fun `同一メッセージの二重配信でもジョブは 1 回しか実行されない`() {
        val queueUrl = createQueue()
        val job = db.createAnalysisJob(analysisRequest("二重配信"))
        sendNotification(queueUrl, job.id)
        sendNotification(queueUrl, job.id)

        val worker = SqsAnalysisWorker(db, sqs, queueUrl, workerSettings())
        assertEquals(1, worker.pollOnce())
        assertEquals(1, worker.pollOnce(), "2 通目も consume されるはず (claim 失敗 → 削除)")

        val finished = assertNotNull(db.getAnalysisJob(job.id))
        assertEquals("succeeded", finished.status, "error: ${finished.errorMessage}")
        assertEquals(1, attemptCount(job.id), "2 通目は claim に失敗して破棄されるはず (二重実行なし)")
        assertEquals(1, resultLayerCount(job.id), "結果レイヤの登録は 1 回だけのはず")
        assertTrue(queueIsEmpty(queueUrl))
    }

    @Test
    @Timeout(120)
    fun `解釈できない毒メッセージは削除されて収束する`() {
        val queueUrl = createQueue()
        sqs.sendMessage { it.queueUrl(queueUrl).messageBody("not-json") }
        val worker = SqsAnalysisWorker(db, sqs, queueUrl, workerSettings())
        assertEquals(1, worker.pollOnce())
        assertTrue(queueIsEmpty(queueUrl))
    }

    // ---------------------------------------------------------------- 強制 kill からの回復 (第 3 層)

    @Test
    @Timeout(180)
    fun `処理中に強制 kill されたワーカーのジョブを別ワーカーが回収し二重実行なしに収束する`() {
        val queueUrl = createQueue()
        val job = db.createAnalysisJob(analysisRequest("kill 回復"))
        sendNotification(queueUrl, job.id)

        // worker A: 独立プロセス (bin/analysis-worker と同じ main)。テスト専用フックで
        // claim 直後に実行を保留させ、その間に SIGKILL する
        // (claim 済み running 行 + 未削除メッセージが残る = 実行中クラッシュの再現)
        val workerA = spawnAnalysisWorker(
            queueUrl,
            mapOf(
                "ANALYSIS_TEST_CLAIM_HOLD_MILLIS" to "120000",
                "ANALYSIS_VISIBILITY_EXTENSION_SECONDS" to "3"
            )
        )
        try {
            waitFor(60_000, "worker A がジョブを claim するはず") {
                assertNotNull(db.getAnalysisJob(job.id)).status == "running"
            }
            assertEquals(1, attemptCount(job.id))
        } finally {
            workerA.destroyForcibly()
            workerA.waitFor()
        }

        // worker B (インプロセス): 短いハートビート途絶閾値と補完スキャンで回収し、最後まで実行する
        val workerB = SqsAnalysisWorker(db, sqs, queueUrl, workerSettings(staleSeconds = 2, reenqueueSeconds = 1))
        waitFor(90_000, "worker B が kill されたジョブを回収して収束させるはず") {
            workerB.sweepNow()
            workerB.pollOnce()
            assertNotNull(db.getAnalysisJob(job.id)).status in setOf("succeeded", "failed")
        }

        val finished = assertNotNull(db.getAnalysisJob(job.id))
        assertEquals("succeeded", finished.status, "error: ${finished.errorMessage}")
        assertEquals(2, attemptCount(job.id), "kill 後の再実行で claim は 2 回目になるはず")
        assertEquals(1, resultLayerCount(job.id), "結果レイヤの登録は 1 回だけ (二重実行なし)")
    }

    /** 分析ワーカー (AnalysisWorkerMain) をテスト JVM と同じクラスパスで独立プロセスとして起動する */
    private fun spawnAnalysisWorker(queueUrl: String, extraEnv: Map<String, String>): Process {
        val javaBin = Path.of(System.getProperty("java.home"), "bin", "java").toString()
        val builder = ProcessBuilder(javaBin, "-cp", System.getProperty("java.class.path"), "gis.example.AnalysisWorkerMainKt")
        builder.environment().putAll(
            mapOf(
                "DATABASE_URL" to IntegrationDb.url,
                "DATABASE_USER" to IntegrationDb.user,
                "DATABASE_PASSWORD" to IntegrationDb.password,
                "JOB_QUEUE_MODE" to "sqs",
                "SQS_ENDPOINT_URL" to "http://localhost:$sqsPort",
                "SQS_ANALYSIS_QUEUE_URL" to queueUrl,
                "SQS_REGION" to "us-east-1",
                "AWS_ACCESS_KEY_ID" to "test",
                "AWS_SECRET_ACCESS_KEY" to "test",
                "ANALYSIS_JOB_HEARTBEAT_SECONDS" to "1",
                "ANALYSIS_RECEIVE_WAIT_SECONDS" to "1",
                "ANALYSIS_SWEEP_INTERVAL_SECONDS" to "1"
            )
        )
        builder.environment().putAll(extraEnv)
        builder.redirectErrorStream(true)
        builder.redirectOutput(ProcessBuilder.Redirect.DISCARD)
        return builder.start()
    }

    // ---------------------------------------------------------------- 収束の保証 (第 5 層)

    @Test
    @Timeout(120)
    fun `試行上限を超えて途絶したジョブはスイープが failed へ収束させる`() {
        val job = db.createAnalysisJob(analysisRequest("試行上限"))
        rawConnection().use { connection ->
            connection.prepareStatement(
                """
                UPDATE app.analysis_jobs
                SET status = 'running', started_at = now() - interval '10 minutes',
                    heartbeat_at = now() - interval '10 minutes', attempt_count = 5
                WHERE id = ?::uuid
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, job.id)
                stmt.executeUpdate()
            }
        }

        val result = db.sweepStaleAnalysisJobs(heartbeatTimeoutSeconds = 60, maxAttempts = 5)

        assertEquals(1, result.failed)
        assertEquals(0, result.requeued)
        val finished = assertNotNull(db.getAnalysisJob(job.id))
        assertEquals("failed", finished.status, "試行上限超過のジョブは failed へ収束するはず")
        assertNotNull(finished.errorMessage)
    }
}
