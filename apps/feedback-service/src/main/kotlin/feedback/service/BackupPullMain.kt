package feedback.service

import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.zip.ZipFile
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

@Serializable
internal data class OAuthTokenResponse(val access_token: String, val token_type: String = "Bearer")

fun main() {
    val settings = BackupPullSettings.fromEnv()
    BackupPullClient().run(settings)
}

internal class BackupPullClient(
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build()
) {
    fun run(settings: BackupPullSettings) {
        val token = requestToken(settings)
        val runs = listRuns(settings, token)
            .filter { it.status == "completed" && it.downloadUrl != null && it.archiveSha256 != null }
            .sortedBy { Instant.parse(it.scheduledFor) }
        Files.createDirectories(settings.destinationDirectory)
        runs.forEach { run -> pull(settings, token, run) }
    }

    internal fun listRuns(settings: BackupPullSettings, token: String): List<FeedbackBackupRun> = buildList {
    var cursor: String? = null
    do {
        val fields = buildList {
            add("applicationKey" to settings.applicationKey)
            add("externalWorkspaceKey" to settings.externalWorkspaceKey)
            add("limit" to "200")
            cursor?.let { add("cursor" to it) }
        }
        val query = fields.joinToString("&") { (key, value) -> "${urlEncode(key)}=${urlEncode(value)}" }
        val response = client.send(
            HttpRequest.newBuilder(URI("${settings.apiBaseUrl}/backups?$query"))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer $token")
                .GET().build(),
            HttpResponse.BodyHandlers.ofString()
        )
        check(response.statusCode() == 200) { "backup list の取得に失敗しました: HTTP ${response.statusCode()}" }
        val page = serviceJson.decodeFromString(FeedbackBackupRunPage.serializer(), response.body())
        addAll(page.items)
        cursor = page.nextCursor
    } while (cursor != null)
    }

    internal fun requestToken(settings: BackupPullSettings): String {
        val fields = listOf(
            "grant_type" to "client_credentials",
            "client_id" to settings.clientId,
            "client_secret" to settings.clientSecret,
            "scope" to settings.scope
        )
        val body = fields.joinToString("&") { (key, value) -> "${urlEncode(key)}=${urlEncode(value)}" }
        val response = client.send(
            HttpRequest.newBuilder(URI(settings.tokenUrl))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
            HttpResponse.BodyHandlers.ofString()
        )
        check(response.statusCode() in 200..299) { "OIDC token の取得に失敗しました: HTTP ${response.statusCode()}" }
        return serviceJson.decodeFromString(OAuthTokenResponse.serializer(), response.body()).access_token
    }

    internal fun pull(settings: BackupPullSettings, token: String, run: FeedbackBackupRun) {
        val name = backupFileName(run)
        val target = resolveBackupTarget(settings.destinationDirectory, name)
        if (Files.isRegularFile(target) && sha256(target) == run.archiveSha256 && verifyBackupManifest(target)) return
        val temporary = Files.createTempFile(settings.destinationDirectory, ".$name-", ".part")
        try {
            val download = client.send(
                HttpRequest.newBuilder(URI("${settings.apiBaseUrl}${run.downloadUrl}"))
                    .timeout(Duration.ofMinutes(5))
                    .header("Authorization", "Bearer $token")
                    .GET().build(),
                HttpResponse.BodyHandlers.ofFile(temporary)
            )
            check(download.statusCode() == 200) { "backup ${run.id} の取得に失敗しました: HTTP ${download.statusCode()}" }
            check(sha256(temporary) == run.archiveSha256) { "backup ${run.id} のSHA-256が一致しません" }
            check(verifyBackupManifest(temporary)) { "backup ${run.id} のmanifest検証に失敗しました" }
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            Files.deleteIfExists(temporary)
        }
    }
}

internal data class BackupPullSettings(
    val apiBaseUrl: String,
    val tokenUrl: String,
    val clientId: String,
    val clientSecret: String,
    val scope: String,
    val applicationKey: String,
    val externalWorkspaceKey: String,
    val destinationDirectory: Path
) {
    companion object {
        fun fromEnv(): BackupPullSettings {
            val destination = Path.of(requiredEnv("FEEDBACK_PULL_DESTINATION_DIR")).toAbsolutePath().normalize()
            validateBackupPullDestination(destination)
            val scope = System.getenv("FEEDBACK_PULL_SCOPE")?.takeIf(String::isNotBlank) ?: "feedback.manage"
            require("feedback.manage" in scope.split(Regex("\\s+")).filter(String::isNotBlank)) {
                "FEEDBACK_PULL_SCOPE にはfeedback.manageが必要です"
            }
            return BackupPullSettings(
                apiBaseUrl = requiredEnv("FEEDBACK_PULL_API_BASE_URL").trimEnd('/'),
                tokenUrl = requiredEnv("FEEDBACK_PULL_TOKEN_URL"),
                clientId = requiredEnv("FEEDBACK_PULL_CLIENT_ID"),
                clientSecret = requiredEnv("FEEDBACK_PULL_CLIENT_SECRET"),
                scope = scope,
                applicationKey = requiredEnv("FEEDBACK_PULL_APPLICATION_KEY"),
                externalWorkspaceKey = requiredEnv("FEEDBACK_PULL_EXTERNAL_WORKSPACE_KEY"),
                destinationDirectory = destination
            )
        }
    }
}

internal fun validateBackupPullDestination(destination: Path) {
    require(destination.isAbsolute && destination.nameCount > 0 && destination != destination.root) {
        "FEEDBACK_PULL_DESTINATION_DIR にfilesystem rootは指定できません"
    }
}

internal fun resolveBackupTarget(destination: Path, name: String): Path {
    require(name.isNotBlank() && '/' !in name && '\\' !in name && name !in setOf(".", "..")) {
        "不正なbackup filenameです"
    }
    val target = destination.resolve(name).normalize()
    require(target.parent == destination) { "不正なbackup filenameです" }
    return target
}

private val backupFileTimestamp = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC)

internal fun backupFileName(run: FeedbackBackupRun): String {
    require(run.kind in setOf("full", "incremental")) { "不正なbackup kindです" }
    val id = UUID.fromString(run.id).toString()
    return "${backupFileTimestamp.format(Instant.parse(run.scheduledFor))}-${run.kind}-$id.zip"
}

internal fun verifyBackupManifest(path: Path): Boolean = runCatching {
    ZipFile(path.toFile()).use { zip ->
        val manifestEntry = zip.getEntry("manifest.json") ?: return false
        val manifest = zip.getInputStream(manifestEntry).use { input ->
            serviceJson.parseToJsonElement(input.reader(StandardCharsets.UTF_8).readText()).jsonObject
        }
        val entries = manifest.getValue("entries").jsonObject
        val expectedNames = entries.keys + "manifest.json"
        val actualNames = zip.entries().asSequence().map { it.name }.toList()
        if (actualNames.size != expectedNames.size || actualNames.toSet() != expectedNames) return false
        entries.all { (name, metadata) ->
            val entry = zip.getEntry(name) ?: return@all false
            val bytes = zip.getInputStream(entry).use { it.readAllBytes() }
            val expected = metadata.jsonObject
            bytes.size.toLong() == expected.getValue("bytes").jsonPrimitive.long &&
                sha256(bytes) == expected.getValue("sha256").jsonPrimitive.content
        }
    }
}.getOrDefault(false)

private fun urlEncode(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")
