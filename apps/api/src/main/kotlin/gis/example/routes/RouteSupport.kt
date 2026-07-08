// ルート層共通のリクエスト検証ヘルパ。SQL や業務ロジックを持ち込まない
package gis.example.routes

import gis.example.ApiException
import io.ktor.http.HttpStatusCode
import java.util.UUID

// 一覧 API の総件数ヘッダ。CORS の exposeHeader にも使う
internal const val TOTAL_COUNT_HEADER = "X-Total-Count"

private const val DEFAULT_LIST_LIMIT = 200
private const val MAX_LIST_LIMIT = 1000

// 一覧 API の limit。未指定は既定値、範囲外・非数値は 400 (openapi.yaml の定義と揃える)
internal fun parseListLimit(value: String?): Int {
    val limit = value?.let {
        it.toIntOrNull() ?: throw ApiException(HttpStatusCode.BadRequest, "limit must be an integer")
    } ?: DEFAULT_LIST_LIMIT
    if (limit < 1 || limit > MAX_LIST_LIMIT) {
        throw ApiException(HttpStatusCode.BadRequest, "limit must be between 1 and $MAX_LIST_LIMIT")
    }
    return limit
}

internal fun parseListOffset(value: String?): Int {
    val offset = value?.let {
        it.toIntOrNull() ?: throw ApiException(HttpStatusCode.BadRequest, "offset must be an integer")
    } ?: 0
    if (offset < 0) {
        throw ApiException(HttpStatusCode.BadRequest, "offset must be 0 or greater")
    }
    return offset
}

internal fun requireUuid(value: String, label: String): String =
    try {
        UUID.fromString(value).toString()
    } catch (_: IllegalArgumentException) {
        throw ApiException(HttpStatusCode.BadRequest, "$label must be a valid UUID")
    }

internal fun optionalUuid(value: String?, label: String): String? =
    value?.takeIf { it.isNotBlank() }?.let { requireUuid(it, label) }
