package feedback.service

import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.Base64

class FeedbackApiException(
    val status: HttpStatusCode,
    val code: String,
    override val message: String
) : RuntimeException(message)

private val applicationKeyPattern = Regex("^[a-z][a-z0-9-]{0,62}$")
private val pageKeyPattern = Regex("^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$")
private val parameterKeyPattern = Regex("^[A-Za-z_][A-Za-z0-9_]*$")
private val queryKeyPattern = Regex("^[A-Za-z_][A-Za-z0-9_.-]*$")
private val routeParameterPattern = Regex("\\{([A-Za-z_][A-Za-z0-9_]*)}")

internal fun badRequest(message: String, code: String = "request.invalid"): Nothing =
    throw FeedbackApiException(HttpStatusCode.BadRequest, code, message)

internal fun notFound(message: String = "リソースが見つかりません"): Nothing =
    throw FeedbackApiException(HttpStatusCode.NotFound, "resource.not_found", message)

internal fun conflict(message: String, code: String = "resource.conflict"): Nothing =
    throw FeedbackApiException(HttpStatusCode.Conflict, code, message)

internal fun preconditionFailed(message: String = "ETag が現在の版と一致しません"): Nothing =
    throw FeedbackApiException(HttpStatusCode.PreconditionFailed, "resource.version_mismatch", message)

internal fun validateApplicationKey(value: String): String = value.also {
    if (!applicationKeyPattern.matches(it)) badRequest("applicationKey が不正です")
}

internal fun validateKey(value: String, name: String, maxLength: Int): String = value.trim().also {
    if (it.isEmpty() || it.length > maxLength) badRequest("$name は 1 文字以上 $maxLength 文字以下で指定してください")
}

internal fun validateUuid(value: String?, name: String): String {
    val candidate = value ?: badRequest("$name がありません")
    return try {
        java.util.UUID.fromString(candidate).toString()
    } catch (_: IllegalArgumentException) {
        badRequest("$name は UUID で指定してください")
    }
}

internal fun validateInstant(value: String?, name: String): String? {
    if (value == null) return null
    try {
        Instant.parse(value)
    } catch (_: DateTimeParseException) {
        badRequest("$name は RFC 3339 date-time で指定してください")
    }
    return value
}

internal fun validateIdempotencyKey(value: String?): String {
    val key = value ?: badRequest("Idempotency-Key が必要です", "idempotency.required")
    if (key.length !in 16..200) badRequest("Idempotency-Key は 16 文字以上 200 文字以下で指定してください")
    return key
}

internal fun parseEtag(value: String?): Int {
    val raw = value ?: badRequest("If-Match が必要です", "etag.required")
    val match = Regex("^(?:W/)?\"v([1-9][0-9]*)\"$").matchEntire(raw)
        ?: badRequest("If-Match は応答された ETag をそのまま指定してください", "etag.invalid")
    return match.groupValues[1].toInt()
}

internal fun etag(version: Int): String = "\"v$version\""

internal fun validateManifest(applicationKey: String, manifest: JsonObject): JsonObject {
    requireExactKeys(
        manifest,
        required = setOf("schemaVersion", "applicationKey", "displayName", "manifestVersion", "routes"),
        optional = emptySet(),
        subject = "manifest"
    )
    if (manifest.string("schemaVersion") != "1") badRequest("未対応の manifest schemaVersion です")
    if (manifest.string("applicationKey") != applicationKey) {
        badRequest("path と manifest の applicationKey が一致しません")
    }
    validateApplicationKey(applicationKey)
    validateKey(manifest.string("displayName"), "displayName", 200)
    validateKey(manifest.string("manifestVersion"), "manifestVersion", 100)
    val routes = manifest["routes"] as? JsonArray ?: badRequest("routes は配列で指定してください")
    if (routes.size !in 1..500) badRequest("routes は 1 件以上 500 件以下で指定してください")
    val pageKeys = mutableSetOf<String>()
    val templates = mutableSetOf<String>()
    routes.forEachIndexed { index, routeElement ->
        val route = routeElement as? JsonObject ?: badRequest("routes[$index] は object で指定してください")
        requireExactKeys(
            route,
            required = setOf("pageKey", "template", "label"),
            optional = setOf("group", "parameters", "queryParameters", "aliases"),
            subject = "routes[$index]"
        )
        val pageKey = route.string("pageKey")
        if (!pageKeyPattern.matches(pageKey) || pageKey.length > 100) badRequest("routes[$index].pageKey が不正です")
        if (!pageKeys.add(pageKey)) badRequest("pageKey が重複しています: $pageKey")
        val template = validateRouteTemplate(route.string("template"), "routes[$index].template")
        if (!templates.add(template)) badRequest("route template が重複しています: $template")
        validateKey(route.string("label"), "routes[$index].label", 200)
        route["group"]?.let { validateKey(it.jsonPrimitive.content, "routes[$index].group", 100) }
        val pathParameterNames = routeParameterPattern.findAll(template).map { it.groupValues[1] }.toSet()
        validateParameterPolicies(route["parameters"], parameterKeyPattern, "routes[$index].parameters", pathParameterNames)
        validateParameterPolicies(route["queryParameters"], queryKeyPattern, "routes[$index].queryParameters", null)
        route["aliases"]?.let { aliasesElement ->
            val aliases = aliasesElement as? JsonArray ?: badRequest("routes[$index].aliases は配列で指定してください")
            if (aliases.size > 20) badRequest("routes[$index].aliases は 20 件以下で指定してください")
            aliases.forEach { alias ->
                val aliasTemplate = validateRouteTemplate(alias.jsonPrimitive.content, "alias")
                if (!templates.add(aliasTemplate)) badRequest("route template/alias が重複しています: $aliasTemplate")
            }
        }
    }
    return manifest
}

private fun validateParameterPolicies(
    element: JsonElement?,
    keyPattern: Regex,
    subject: String,
    expectedKeys: Set<String>?
) {
    val policies = element?.let { it as? JsonObject ?: badRequest("$subject は object で指定してください") }
        ?: JsonObject(emptyMap())
    policies.forEach { (key, value) ->
        if (!keyPattern.matches(key)) badRequest("$subject の parameter 名が不正です: $key")
        val policy = value as? JsonObject ?: badRequest("$subject.$key は object で指定してください")
        requireExactKeys(policy, setOf("persistence"), emptySet(), "$subject.$key")
        if (policy.string("persistence") !in setOf("store", "hash", "discard")) {
            badRequest("$subject.$key.persistence が不正です")
        }
    }
    if (expectedKeys != null && policies.keys != expectedKeys) {
        badRequest("$subject は template parameter と一致させてください")
    }
}

private fun validateRouteTemplate(value: String, subject: String): String {
    if (!value.startsWith('/') || value.length > 500 || '?' in value || '#' in value || "//" in value) {
        badRequest("$subject が不正です")
    }
    val stripped = routeParameterPattern.replace(value, "x")
    if ('{' in stripped || '}' in stripped) badRequest("$subject の parameter が不正です")
    return value
}

internal fun sanitizeLocation(location: JsonObject, manifest: JsonObject): JsonObject {
    requireExactKeys(
        location,
        setOf("schemaVersion", "pageKey", "routeTemplate", "pathParameters"),
        setOf("queryParameters"),
        "location"
    )
    if (location.string("schemaVersion") != "1") badRequest("location.schemaVersion は 1 を指定してください")
    val pageKey = location.string("pageKey")
    val routeTemplate = location.string("routeTemplate")
    val route = manifest["routes"]!!.jsonArray.map { it.jsonObject }.firstOrNull {
        it.string("pageKey") == pageKey &&
            (it.string("template") == routeTemplate || it["aliases"]?.jsonArray?.any { alias ->
                alias.jsonPrimitive.content == routeTemplate
            } == true)
    } ?: badRequest("location は登録済み manifest route と一致しません", "location.unregistered")
    val pathValues = location["pathParameters"] as? JsonObject
        ?: badRequest("location.pathParameters は object で指定してください")
    val queryValues = location["queryParameters"] as? JsonObject ?: JsonObject(emptyMap())
    val pathPolicies = route["parameters"] as? JsonObject ?: JsonObject(emptyMap())
    val queryPolicies = route["queryParameters"] as? JsonObject ?: JsonObject(emptyMap())
    if (pathValues.keys != pathPolicies.keys) badRequest("pathParameters は manifest parameter と一致させてください")
    val sanitizedPath = sanitizeParameters(pathValues, pathPolicies, 500)
    val sanitizedQuery = sanitizeParameters(queryValues, queryPolicies, 1000)
    return JsonObject(buildMap {
        put("schemaVersion", JsonPrimitive("1"))
        put("pageKey", JsonPrimitive(pageKey))
        put("routeTemplate", JsonPrimitive(routeTemplate))
        put("pathParameters", sanitizedPath)
        if (sanitizedQuery.isNotEmpty()) put("queryParameters", sanitizedQuery)
    })
}

private fun sanitizeParameters(values: JsonObject, policies: JsonObject, maxLength: Int): JsonObject =
    JsonObject(buildMap {
        values.forEach { (key, value) ->
            val policy = policies[key]?.jsonObject ?: return@forEach
            val raw = value.jsonPrimitive.content
            if (raw.length > maxLength) badRequest("parameter $key が長すぎます")
            when (policy.string("persistence")) {
                "store" -> put(key, JsonPrimitive(raw))
                "hash" -> put(key, JsonPrimitive("sha256:${sha256(raw.toByteArray())}"))
                "discard" -> Unit
            }
        }
    })

internal fun validateTarget(target: JsonObject): JsonObject {
    if (target.string("schemaVersion") != "1") badRequest("target.schemaVersion は 1 を指定してください")
    when (target.string("kind")) {
        "ui-element" -> {
            requireExactKeys(target, setOf("schemaVersion", "kind", "elementKey", "relativeX", "relativeY"), emptySet(), "target")
            validateKey(target.string("elementKey"), "elementKey", 200)
            validateRelative(target, "relativeX")
            validateRelative(target, "relativeY")
        }
        "screen-position" -> {
            requireExactKeys(target, setOf("schemaVersion", "kind", "relativeX", "relativeY"), emptySet(), "target")
            validateRelative(target, "relativeX")
            validateRelative(target, "relativeY")
        }
        "map-feature" -> {
            requireExactKeys(
                target,
                setOf("schemaVersion", "kind", "provider", "sourceKey", "featureKey", "longitude", "latitude"),
                setOf("sourceLayer"),
                "target"
            )
            if (target.string("provider") != "maplibre") badRequest("map-feature.provider は maplibre を指定してください")
            validateKey(target.string("sourceKey"), "sourceKey", 200)
            validateKey(target.string("featureKey"), "featureKey", 200)
            target["sourceLayer"]?.let { validateKey(it.jsonPrimitive.content, "sourceLayer", 200) }
            validateCoordinate(target, "longitude", -180.0, 180.0)
            validateCoordinate(target, "latitude", -90.0, 90.0)
        }
        "map-position" -> {
            requireExactKeys(target, setOf("schemaVersion", "kind", "longitude", "latitude"), emptySet(), "target")
            validateCoordinate(target, "longitude", -180.0, 180.0)
            validateCoordinate(target, "latitude", -90.0, 90.0)
        }
        else -> badRequest("target.kind が不正です")
    }
    return target
}

private fun validateRelative(target: JsonObject, key: String) = validateCoordinate(target, key, 0.0, 1.0)

private fun validateCoordinate(target: JsonObject, key: String, minimum: Double, maximum: Double) {
    val value = target[key]?.jsonPrimitive?.doubleOrNull ?: badRequest("target.$key は数値で指定してください")
    if (!value.isFinite() || value !in minimum..maximum) badRequest("target.$key が範囲外です")
}

internal fun decodeEvidence(input: EvidenceCreateRequest, maxBytes: Long): ByteArray {
    if (input.contentType !in setOf("image/png", "image/webp")) badRequest("evidence contentType が不正です")
    if (input.viewportWidth < 1 || input.viewportHeight < 1 || input.pixelRatio !in 0.1..8.0) {
        badRequest("evidence の viewport または pixelRatio が不正です")
    }
    validateInstant(input.capturedAt, "evidence.capturedAt")
    val maxEncodedLength = ((maxBytes + 2) / 3) * 4 + 4
    if (input.dataBase64.length.toLong() > maxEncodedLength) {
        throw FeedbackApiException(HttpStatusCode.PayloadTooLarge, "evidence.too_large", "evidence が上限を超えています")
    }
    val bytes = try {
        Base64.getDecoder().decode(input.dataBase64)
    } catch (_: IllegalArgumentException) {
        badRequest("evidence.dataBase64 が不正です")
    }
    if (bytes.isEmpty()) badRequest("evidence が空です")
    if (bytes.size.toLong() > maxBytes) {
        throw FeedbackApiException(HttpStatusCode.PayloadTooLarge, "evidence.too_large", "evidence が上限を超えています")
    }
    val validMagic = when (input.contentType) {
        "image/png" -> bytes.size >= 8 && bytes.take(8) == listOf(137, 80, 78, 71, 13, 10, 26, 10).map(Int::toByte)
        "image/webp" -> bytes.size >= 12 && bytes.copyOfRange(0, 4).decodeToString() == "RIFF" &&
            bytes.copyOfRange(8, 12).decodeToString() == "WEBP"
        else -> false
    }
    if (!validMagic) badRequest("evidence の内容が contentType と一致しません")
    return bytes
}

internal fun validateNotificationSettings(value: FeedbackNotificationSettings) {
    if (value.webhookEnabled && value.webhookEndpoint == null) badRequest("webhookEnabled=true では endpoint が必要です")
    value.webhookEndpoint?.let { raw ->
        val uri = try {
            URI(raw)
        } catch (_: IllegalArgumentException) {
            badRequest("webhookEndpoint が不正です")
        }
        if (uri.scheme != "https" || uri.host == null || uri.userInfo != null || uri.fragment != null) {
            badRequest("webhookEndpoint は userinfo/fragment を含まない https URL で指定してください")
        }
    }
    if (value.includeEvidence) badRequest("v1 では webhook への evidence 添付を許可していません")
}

internal fun validateRetentionPolicy(value: FeedbackRetentionPolicy) {
    if (value.evidenceRetentionDays != null && value.evidenceRetentionDays !in 1..3650) {
        badRequest("evidenceRetentionDays が範囲外です")
    }
    if (value.exportRetentionDays !in 1..365) badRequest("exportRetentionDays が範囲外です")
}

internal fun requestHash(element: JsonElement): String = sha256(serviceJson.encodeToString(JsonElement.serializer(), element).toByteArray())

internal fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private fun JsonObject.string(key: String): String =
    this[key]?.takeUnless { it is JsonNull }?.jsonPrimitive?.contentOrNull ?: badRequest("$key がありません")

private fun requireExactKeys(
    value: JsonObject,
    required: Set<String>,
    optional: Set<String>,
    subject: String
) {
    val missing = required - value.keys
    val unknown = value.keys - required - optional
    if (missing.isNotEmpty()) badRequest("$subject に必須 field がありません: ${missing.sorted()}")
    if (unknown.isNotEmpty()) badRequest("$subject に未知 field があります: ${unknown.sorted()}")
}
