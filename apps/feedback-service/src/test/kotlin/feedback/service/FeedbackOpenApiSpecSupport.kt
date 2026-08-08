package feedback.service

import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.time.OffsetDateTime
import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml

/** 専用 OpenAPI が使用する JSON Schema 2020-12 の部分集合を fail-closed で検証する。 */
object FeedbackOpenApiSpecSupport {
    data class SchemaNode(
        val definition: Map<String, Any?>,
        val document: Map<String, Any?>,
        val source: Path
    )

    private val supportedKeywords = setOf(
        "\$schema", "\$id", "\$ref", "title", "description", "type", "const", "enum",
        "properties", "required", "items", "additionalProperties", "propertyNames", "oneOf",
        "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "default",
        "minItems", "maxItems", "minProperties", "maxProperties", "contentEncoding"
    )
    private val yaml = Yaml(LoaderOptions().apply { codePointLimit = 10 * 1024 * 1024 })
    private val specPath: Path by lazy { findRepositoryRoot().resolve("contracts/feedback/openapi.yaml") }
    private val document: Map<String, Any?> by lazy { loadDocument(specPath) }

    fun responseSchema(method: String, path: String, status: Int, mediaType: String): SchemaNode {
        val paths = document.map("paths")
        val pathItem = paths.map(path)
        val operation = pathItem.map(method.lowercase())
        val response = dereference(
            SchemaNode(operation.map("responses").map(status.toString()), document, specPath)
        )
        val media = response.definition.map("content").map(mediaType)
        return SchemaNode(media.map("schema"), response.document, response.source)
    }

    fun validate(element: JsonElement, schema: SchemaNode): List<String> = buildList {
        validateInto(element, schema, "$", this)
    }

    private fun validateInto(
        element: JsonElement,
        unresolved: SchemaNode,
        location: String,
        errors: MutableList<String>
    ) {
        val schema = dereference(unresolved)
        val definition = schema.definition
        val unknownKeywords = definition.keys - supportedKeywords
        require(unknownKeywords.isEmpty()) {
            "$location: 未対応の JSON Schema keyword です: ${unknownKeywords.sorted()}"
        }

        definition.listOfMaps("oneOf")?.let { alternatives ->
            val results = alternatives.map { alternative ->
                buildList {
                    validateInto(element, SchemaNode(alternative, schema.document, schema.source), location, this)
                }
            }
            if (results.count { it.isEmpty() } != 1) errors += "$location: oneOf の候補に一意に適合しません"
            return
        }

        val types = when (val type = definition["type"]) {
            null -> null
            is String -> listOf(type)
            is List<*> -> type.map { it as? String ?: error("$location: type 配列が不正です") }
            else -> error("$location: 未対応の type 表現です: $type")
        }
        if (types != null && types.none { matchesType(element, it) }) {
            errors += "$location: 型が契約と一致しません (期待: $types、実際: ${describe(element)})"
            return
        }
        if (element is JsonNull) return

        definition["const"]?.let { expected ->
            if (!matchesScalar(element, expected)) errors += "$location: const $expected と一致しません"
        }
        (definition["enum"] as? List<*>)?.let { allowed ->
            if (allowed.none { matchesScalar(element, it) }) errors += "$location: enum 外の値です"
        }

        if (element is JsonObject) validateObject(element, schema, location, errors)
        if (element is JsonArray) validateArray(element, schema, location, errors)
        if (element is JsonPrimitive && element.isString) validateString(element.content, definition, location, errors)
        if (element is JsonPrimitive && !element.isString) validateNumber(element, definition, location, errors)
    }

    private fun validateObject(
        element: JsonObject,
        schema: SchemaNode,
        location: String,
        errors: MutableList<String>
    ) {
        val definition = schema.definition
        val required = definition["required"] as? List<*> ?: emptyList<Any?>()
        required.map { it as? String ?: error("$location: required が不正です") }.forEach { field ->
            if (field !in element) errors += "$location: 必須フィールド '$field' がありません"
        }
        val properties = definition["properties"].asMapOrEmpty()
        properties.forEach { (name, child) ->
            element[name]?.let {
                validateInto(it, SchemaNode(child.asMap(), schema.document, schema.source), "$location.$name", errors)
            }
        }
        val unknown = element.keys - properties.keys
        when (val additional = definition["additionalProperties"]) {
            false -> unknown.forEach { errors += "$location: 未定義フィールド '$it' があります" }
            is Map<*, *> -> unknown.forEach { name ->
                validateInto(
                    element.getValue(name),
                    SchemaNode(additional.asStringMap(), schema.document, schema.source),
                    "$location.$name",
                    errors
                )
            }
        }
        (definition["propertyNames"] as? Map<*, *>)?.asStringMap()?.let { propertySchema ->
            element.keys.forEach { name ->
                validateInto(
                    JsonPrimitive(name),
                    SchemaNode(propertySchema, schema.document, schema.source),
                    "$location.<propertyName>",
                    errors
                )
            }
        }
        checkSize(element.size, definition, "minProperties", "maxProperties", location, errors)
    }

    private fun validateArray(
        element: JsonArray,
        schema: SchemaNode,
        location: String,
        errors: MutableList<String>
    ) {
        (schema.definition["items"] as? Map<*, *>)?.asStringMap()?.let { itemSchema ->
            element.forEachIndexed { index, item ->
                validateInto(item, SchemaNode(itemSchema, schema.document, schema.source), "$location[$index]", errors)
            }
        }
        checkSize(element.size, schema.definition, "minItems", "maxItems", location, errors)
    }

    private fun validateString(
        value: String,
        definition: Map<String, Any?>,
        location: String,
        errors: MutableList<String>
    ) {
        checkSize(value.length, definition, "minLength", "maxLength", location, errors)
        (definition["pattern"] as? String)?.let {
            if (!Regex(it).containsMatchIn(value)) errors += "$location: pattern 不一致です"
        }
        when (definition["format"] as? String) {
            null, "binary" -> Unit
            "uuid" -> if (runCatching { UUID.fromString(value) }.isFailure) errors += "$location: UUID ではありません"
            "date-time" -> if (runCatching { OffsetDateTime.parse(value) }.isFailure) errors += "$location: date-time ではありません"
            "uri" -> if (!runCatching { URI(value).isAbsolute }.getOrDefault(false)) errors += "$location: absolute URI ではありません"
            "uri-reference" -> if (runCatching { URI(value) }.isFailure) errors += "$location: URI reference ではありません"
            else -> error("$location: 未対応の format です: ${definition["format"]}")
        }
    }

    private fun validateNumber(
        value: JsonPrimitive,
        definition: Map<String, Any?>,
        location: String,
        errors: MutableList<String>
    ) {
        val number = value.doubleOrNull ?: return
        (definition["minimum"] as? Number)?.toDouble()?.let { if (number < it) errors += "$location: minimum 未満です" }
        (definition["maximum"] as? Number)?.toDouble()?.let { if (number > it) errors += "$location: maximum 超過です" }
    }

    private fun checkSize(
        actual: Int,
        definition: Map<String, Any?>,
        minimumKey: String,
        maximumKey: String,
        location: String,
        errors: MutableList<String>
    ) {
        (definition[minimumKey] as? Number)?.toInt()?.let { if (actual < it) errors += "$location: $minimumKey 未満です" }
        (definition[maximumKey] as? Number)?.toInt()?.let { if (actual > it) errors += "$location: $maximumKey 超過です" }
    }

    private fun dereference(node: SchemaNode): SchemaNode {
        val ref = node.definition["\$ref"] as? String ?: return node
        val (source, pointer) = if (ref.startsWith("#/")) {
            node.source to ref
        } else {
            val parts = ref.split('#', limit = 2)
            node.source.parent.resolve(parts[0]).normalize() to parts.getOrNull(1)?.let { "#$it" }
        }
        val targetDocument = if (source == node.source) node.document else loadDocument(source)
        val target = pointer?.let { resolvePointer(targetDocument, it) } ?: targetDocument
        return dereference(SchemaNode(target, targetDocument, source))
    }

    private fun resolvePointer(root: Map<String, Any?>, pointer: String): Map<String, Any?> {
        require(pointer.startsWith("#/")) { "内部 JSON pointer だけを許可します: $pointer" }
        var value: Any? = root
        pointer.removePrefix("#/").split('/').forEach { raw ->
            val segment = raw.replace("~1", "/").replace("~0", "~")
            value = value.asMap()[segment] ?: error("$pointer を解決できません: $segment")
        }
        return value.asMap()
    }

    private fun matchesType(element: JsonElement, type: String): Boolean = when (type) {
        "null" -> element is JsonNull
        "object" -> element is JsonObject
        "array" -> element is JsonArray
        "string" -> element is JsonPrimitive && element !is JsonNull && element.isString
        "boolean" -> element is JsonPrimitive && !element.isString && element.booleanOrNull != null
        "integer" -> element is JsonPrimitive && !element.isString && element.longOrNull != null
        "number" -> element is JsonPrimitive && !element.isString && element.doubleOrNull != null
        else -> error("未対応の type です: $type")
    }

    private fun matchesScalar(element: JsonElement, expected: Any?): Boolean = when (expected) {
        null -> element is JsonNull
        is Boolean -> element is JsonPrimitive && element.booleanOrNull == expected
        is Number -> element is JsonPrimitive && element.doubleOrNull == expected.toDouble()
        else -> element is JsonPrimitive && element.isString && element.content == expected.toString()
    }

    private fun describe(element: JsonElement): String = when (element) {
        is JsonNull -> "null"
        is JsonObject -> "object"
        is JsonArray -> "array"
        is JsonPrimitive -> if (element.isString) "string" else "number/boolean"
    }

    private fun findRepositoryRoot(): Path {
        var directory = Path.of("").toAbsolutePath()
        while (!Files.exists(directory.resolve(".git"))) {
            directory = directory.parent ?: error("repository root が見つかりません")
        }
        return directory
    }

    private fun loadDocument(path: Path): Map<String, Any?> = Files.newBufferedReader(path).use { reader ->
        @Suppress("UNCHECKED_CAST")
        (yaml.load<Any?>(reader) as? Map<String, Any?>) ?: error("schema document が object ではありません: $path")
    }

    private fun Map<String, Any?>.map(key: String): Map<String, Any?> =
        get(key).asMapOrNull() ?: error("$key が object ではありません")

    private fun Map<String, Any?>.listOfMaps(key: String): List<Map<String, Any?>>? =
        (get(key) as? List<*>)?.map { it.asMap() }

    private fun Any?.asMap(): Map<String, Any?> = asMapOrNull() ?: error("object ではありません: $this")

    private fun Any?.asMapOrNull(): Map<String, Any?>? = (this as? Map<*, *>)?.asStringMap()

    private fun Any?.asMapOrEmpty(): Map<String, Any?> = asMapOrNull() ?: emptyMap()

    private fun Map<*, *>.asStringMap(): Map<String, Any?> = entries.associate { (key, value) ->
        (key as? String ?: error("schema object の key が文字列ではありません")) to value
    }
}
