// 監査ログへの変更内容 (diff) 記録 (issue #23)。
//
// 仕組み (呼び忘れが構造的に起きにくい設計):
// - 更新系のクエリ関数 (createLand / updateZone / deleteLayer 等) は必須引数 AuditTrail を受け取り、
//   変更前後のスナップショットから diff を登録する。引数が必須なので、更新系クエリを追加・呼び出す
//   ときに監査記録の配線を忘れるとコンパイルが通らない
// - ルートは call.auditTrail() で 1 リクエスト分の AuditTrail を取り出してクエリへ渡すだけでよい
// - 書き込みは横断プラグイン auditLogPlugin (AuditLog.kt) が ResponseSent 時に
//   app.audit_logs.detail (jsonb) へ 1 行として保存する (成功応答のみ。失敗時は記録しない)
//
// detail の JSON 形:
// {
//   "changes": [
//     {
//       "entityType": "land",
//       "entityId": "L-1",
//       "operation": "update",                       // create / update / delete
//       "fields": {
//         "status": {"before": "調査中", "after": "完了"},   // update: 変更があったフィールドのみ
//         "memo":   {"before": null,     "after": "追記"}
//       }
//     }
//   ]
// }
// - create は after のみ (null フィールドは省略 = 設定された値の全体)
// - delete は before のみ (同上)
// - 変更なしの update も fields = {} で記録する。issue #23 の「対象リソース ID がパスから
//   推測するしかない」問題への対応として、成功した更新系操作は常に対象 (entityType/entityId) を
//   detail から復元できるようにするため
package gis.example

import io.ktor.server.application.ApplicationCall
import io.ktor.util.AttributeKey
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest

// ルートハンドラが AuditTrail を格納し、auditLogPlugin が読み出す
internal val AuditedChanges = AttributeKey<AuditTrail>("audit.changes")

/** 1 リクエスト分の監査 diff 収集器を取り出す (無ければ作って call に紐づける) */
fun ApplicationCall.auditTrail(): AuditTrail =
    attributes.getOrNull(AuditedChanges) ?: AuditTrail().also { attributes.put(AuditedChanges, it) }

// 1 フィールド値の記録上限 (文字数)。geometry (GeoJSON) など巨大な値の全文を detail に載せると
// audit_logs が DB を圧迫するため、超過分は「変更あり (サイズ/ハッシュ)」の要約形に落とす。
// 1000 文字は業務属性 (住所・メモ・登記情報等) がまず超えず、ポリゴン GeoJSON がほぼ確実に
// 超える境界として選んだ定数 (環境ごとに変える運用要件がないため env にしない)
internal const val AUDIT_MAX_VALUE_CHARS = 1000

// 1 リクエストで記録する変更エントリ数の上限 (一括操作の暴走で detail 1 行が際限なく伸びない保険)
internal const val AUDIT_MAX_CHANGES = 100

// 機微フィールドの denylist (フィールド名の小文字部分一致)。現状の対象エンティティに
// パスワード等は存在しないが、将来フィールドが増えても平文が diff に載らない構造にしておく
private val sensitiveFieldFragments = listOf("password", "secret", "token", "credential", "apikey", "api_key")

internal const val AUDIT_MASKED_VALUE = "***"

/**
 * 更新系操作の変更内容を収集する。クエリ層が record* を呼び、
 * auditLogPlugin が detailJsonOrNull() で audit_logs.detail へ書き込む
 */
class AuditTrail {
    private data class Entry(
        val entityType: String,
        val entityId: String,
        val operation: String,
        val fields: JsonObject
    )

    private val entries = mutableListOf<Entry>()

    fun recordCreate(entityType: String, entityId: String, after: JsonObject) {
        entries += Entry(entityType, entityId, "create", diffFields(before = null, after = after))
    }

    fun recordUpdate(entityType: String, entityId: String, before: JsonObject, after: JsonObject) {
        entries += Entry(entityType, entityId, "update", diffFields(before, after))
    }

    fun recordDelete(entityType: String, entityId: String, before: JsonObject) {
        entries += Entry(entityType, entityId, "delete", diffFields(before, after = null))
    }

    /** audit_logs.detail (jsonb) に書き込む JSON 文字列。記録がなければ null (detail は NULL のまま) */
    fun detailJsonOrNull(): String? {
        if (entries.isEmpty()) return null
        return buildJsonObject {
            put(
                "changes",
                buildJsonArray {
                    entries.take(AUDIT_MAX_CHANGES).forEach { entry ->
                        add(
                            buildJsonObject {
                                put("entityType", entry.entityType)
                                put("entityId", entry.entityId)
                                put("operation", entry.operation)
                                put("fields", entry.fields)
                            }
                        )
                    }
                }
            )
            if (entries.size > AUDIT_MAX_CHANGES) {
                put("omittedChanges", entries.size - AUDIT_MAX_CHANGES)
            }
        }.toString()
    }
}

// フィールドごとの before/after を作る。
// - update (before/after 両方あり): 値が変わったフィールドだけを {before, after} で記録する
// - create (before なし): null 以外の全フィールドを {after} で記録する
// - delete (after なし): null 以外の全フィールドを {before} で記録する
private fun diffFields(before: JsonObject?, after: JsonObject?): JsonObject {
    val keys = (before?.keys.orEmpty() + after?.keys.orEmpty()).toSortedSet()
    return buildJsonObject {
        for (key in keys) {
            val beforeValue = before?.get(key) ?: JsonNull
            val afterValue = after?.get(key) ?: JsonNull
            if (before != null && after != null && beforeValue == afterValue) continue
            if (before == null && afterValue == JsonNull) continue
            if (after == null && beforeValue == JsonNull) continue
            put(
                key,
                buildJsonObject {
                    if (before != null) put("before", sanitizeAuditValue(key, beforeValue))
                    if (after != null) put("after", sanitizeAuditValue(key, afterValue))
                }
            )
        }
    }
}

// 機微フィールドのマスクとサイズ上限の要約化。要約形は
// {"truncated": true, "sizeChars": <文字数>, "sha256": <先頭16桁>} で
// 「変更があったこと」と値の同一性 (ハッシュ突合) だけを追跡できるようにする
internal fun sanitizeAuditValue(fieldName: String, value: JsonElement): JsonElement {
    if (value is JsonNull) return value
    val lowered = fieldName.lowercase()
    if (sensitiveFieldFragments.any { it in lowered }) return JsonPrimitive(AUDIT_MASKED_VALUE)
    val encoded = value.toString()
    if (encoded.length <= AUDIT_MAX_VALUE_CHARS) return value
    return buildJsonObject {
        put("truncated", true)
        put("sizeChars", encoded.length)
        put("sha256", sha256Hex(encoded).take(16))
    }
}

private fun sha256Hex(value: String): String =
    MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

// ---------------------------------------------------------------- エンティティ別スナップショット
//
// DTO を JSON にしたものを行スナップショットとして使う (encodeDefaults = true の databaseJson で
// 全フィールドを出し、update 時の before/after 比較を欠損キーなしで行う)。
// 別エンティティの変更で変わる派生・関連フィールド (関連リスト・結合ラベル・集計値) は
// 行本体の diff に混ざるとノイズになるため除外する

internal fun <T> auditSnapshot(serializer: KSerializer<T>, value: T, exclude: Set<String> = emptySet()): JsonObject {
    val encoded = databaseJson.encodeToJsonElement(serializer, value).jsonObject
    return if (exclude.isEmpty()) encoded else JsonObject(encoded.filterKeys { it !in exclude })
}

internal fun LandDto.auditSnapshot(): JsonObject =
    auditSnapshot(LandDto.serializer(), this, exclude = setOf("buildings", "relationships"))

internal fun BuildingDto.auditSnapshot(): JsonObject =
    auditSnapshot(BuildingDto.serializer(), this, exclude = setOf("relationships", "landLabel"))

internal fun PartyDto.auditSnapshot(): JsonObject =
    auditSnapshot(PartyDto.serializer(), this, exclude = setOf("relationships"))

internal fun PartyRelationshipDto.auditSnapshot(): JsonObject =
    auditSnapshot(PartyRelationshipDto.serializer(), this, exclude = setOf("partyName", "targetLabel"))

internal fun ZoneDto.auditSnapshot(): JsonObject =
    auditSnapshot(ZoneDto.serializer(), this, exclude = setOf("lands", "buildings", "landCount", "buildingCount"))

internal fun LayerDto.auditSnapshot(): JsonObject =
    auditSnapshot(LayerDto.serializer(), this, exclude = setOf("attributes", "bbox4326"))

internal fun UserDto.auditSnapshot(): JsonObject =
    auditSnapshot(UserDto.serializer(), this)

internal fun ProjectMemberDto.auditSnapshot(): JsonObject =
    auditSnapshot(ProjectMemberDto.serializer(), this, exclude = setOf("email", "displayName"))

// フィーチャは動的スキーマ (レイヤごとに列が違う) のため、行の to_jsonb 由来の properties に
// geometry を足した形をスナップショットとする。巨大な geometry は sanitizeAuditValue が要約する
internal fun FeatureDto.auditSnapshot(): JsonObject =
    JsonObject(properties + mapOf("geometry" to (geometry ?: JsonNull)))
