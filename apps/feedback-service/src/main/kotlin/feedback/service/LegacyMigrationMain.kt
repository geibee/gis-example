package feedback.service

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.nio.file.Files
import java.nio.file.Path

/**
 * 旧 Web GIS の匿名化 snapshot を対象にした Phase 4 copy CLI。
 * DB/schema の作成や旧データの削除は行わず、apply/rollback は確認 flag を必須にする。
 */
fun main(arguments: Array<String>) {
    val command = arguments.firstOrNull() ?: usage()
    val options = parseOptions(arguments.drop(1))
    val inputPath = Path.of(options["--input"] ?: usage())
    require(Files.isRegularFile(inputPath)) { "--input の snapshot file がありません" }
    val snapshot = serviceJson.decodeFromString<LegacyFeedbackSnapshot>(Files.readString(inputPath))
    FeedbackDatabase.create(DatabaseSettings.fromEnv()).use { database ->
        createEvidenceStorage(EvidenceStorageSettings.fromEnv()).use { storage ->
            val migration = LegacyFeedbackMigration(database, storage)
            val report = when (command) {
                "dry-run" -> migration.dryRun(snapshot)
                "apply" -> {
                    require("--confirm-copy" in options) {
                        "apply には対象・backup・rollback の人手承認後に --confirm-copy が必要です"
                    }
                    migration.apply(snapshot, options["--run-id"] ?: migration.dryRun(snapshot).runId)
                }
                "reconcile" -> migration.reconcile(snapshot, options["--run-id"] ?: usage())
                "rollback" -> {
                    require("--confirm-rollback" in options) {
                        "rollback には差分確認後に --confirm-rollback が必要です"
                    }
                    migration.rollback(snapshot, options["--run-id"] ?: usage())
                }
                else -> usage()
            }
            println(serviceJson.encodeToString(report))
        }
    }
}

private fun parseOptions(arguments: List<String>): Map<String, String> {
    val options = mutableMapOf<String, String>()
    var index = 0
    while (index < arguments.size) {
        val key = arguments[index]
        require(key in setOf("--input", "--run-id", "--confirm-copy", "--confirm-rollback")) {
            "未知の option です: $key"
        }
        if (key.startsWith("--confirm-")) {
            options[key] = "true"
            index += 1
        } else {
            require(index + 1 < arguments.size) { "$key の値がありません" }
            options[key] = arguments[index + 1]
            index += 2
        }
    }
    return options
}

private fun usage(): Nothing = error(
    "usage: feedback-legacy-migration <dry-run|apply|reconcile|rollback> " +
        "--input <snapshot.json> [--run-id <uuid>] [--confirm-copy|--confirm-rollback]"
)
