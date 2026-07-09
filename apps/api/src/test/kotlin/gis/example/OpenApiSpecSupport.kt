// openapi.yaml (API 契約の SSoT) をテストから読むための共通ヘルパ。
// - 操作一覧 (メソッド + パス) の抽出と正規化: OpenApiContractSyncTest が実装ルートと突合する
// - レスポンススキーマの解決と JSON 検証: ContractResponseIntegrationTest が実レスポンスを検証する
//
// スキーマ検証は openapi.yaml が実際に使っている JSON Schema のサブセット
// ($ref / type (配列可) / properties / required / items / enum) のみを解釈する薄い実装。
// 汎用バリデータ (networknt 等) を入れない選択の理由:
// - 依存を Jackson スタックごと持ち込まずに済む (本体は kotlinx.serialization で統一されている)
// - OpenAPI 3.1 と JSON Schema 方言の差異 (nullable の表現等) を自前で握れる
// 未対応のキーワードに当たった場合は黙って通さず失敗させる (fail-closed)
package gis.example

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
import java.nio.file.Files
import java.nio.file.Path

object OpenApiSpecSupport {

    /** openapi.yaml で操作を表す HTTP メソッドキー (paths 直下の parameters 等と区別する) */
    private val HTTP_METHODS = setOf("get", "put", "post", "delete", "patch", "head", "options", "trace")

    val document: Map<String, Any?> by lazy {
        val yaml = Yaml(LoaderOptions().apply { codePointLimit = 10 * 1024 * 1024 })
        Files.newBufferedReader(specPath()).use { reader ->
            @Suppress("UNCHECKED_CAST")
            yaml.load<Any?>(reader) as Map<String, Any?>
        }
    }

    /** gradle test の作業ディレクトリ (apps/api) からでもリポジトリルートからでも openapi.yaml を見つける */
    private fun specPath(): Path {
        var dir = Path.of("").toAbsolutePath()
        while (true) {
            val direct = dir.resolve("openapi.yaml")
            if (Files.exists(direct) && Files.exists(dir.resolve("build.gradle.kts"))) return direct
            val fromRoot = dir.resolve("apps/api/openapi.yaml")
            if (Files.exists(fromRoot)) return fromRoot
            dir = dir.parent ?: error("openapi.yaml が見つかりません (apps/api/openapi.yaml)")
        }
    }

    /**
     * 契約に定義された全操作を正規化形 "METHOD /path" で返す。
     * パスパラメータはパラメータ名の差異 ({id} と {landId} 等) が偽陽性ドリフトに
     * ならないよう "{}" プレースホルダへ正規化する (ルーティング上は同一の形のため)
     */
    fun operations(): Set<String> {
        @Suppress("UNCHECKED_CAST")
        val paths = document["paths"] as? Map<String, Any?> ?: error("openapi.yaml に paths がありません")
        return paths.flatMap { (path, item) ->
            @Suppress("UNCHECKED_CAST")
            val operations = (item as? Map<String, Any?> ?: emptyMap()).keys.filter { it in HTTP_METHODS }
            operations.map { method -> "${method.uppercase()} ${normalizePath(path)}" }
        }.toSet()
    }

    /** パスのパラメータセグメント ({id} / {layerId} / $id 表記) を "{}" に正規化する */
    fun normalizePath(path: String): String =
        path.trimEnd('/').split("/").joinToString("/") { segment ->
            if ((segment.startsWith("{") && segment.endsWith("}")) || segment.startsWith("$")) "{}" else segment
        }.ifEmpty { "/" }

    /**
     * "paths → <path> → <method> → responses → <status> → content → application/json → schema"
     * のレスポンススキーマを取り出す。契約に存在しない組み合わせはテスト失敗にする
     */
    fun responseSchema(method: String, path: String, status: Int): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        val paths = document["paths"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val pathItem = paths[path] as? Map<String, Any?>
            ?: error("openapi.yaml に $path がありません")
        @Suppress("UNCHECKED_CAST")
        val operation = pathItem[method.lowercase()] as? Map<String, Any?>
            ?: error("openapi.yaml の $path に ${method.lowercase()} がありません")
        @Suppress("UNCHECKED_CAST")
        var response = (operation["responses"] as Map<String, Any?>)["$status"] as? Map<String, Any?>
            ?: error("openapi.yaml の $method $path に $status 応答の定義がありません")
        // 401 等の共通応答は #/components/responses/* への $ref で書かれている
        (response["\$ref"] as? String)?.let { response = resolvePointer(it) }
        @Suppress("UNCHECKED_CAST")
        val content = response["content"] as? Map<String, Any?>
            ?: error("openapi.yaml の $method $path $status に content がありません")
        @Suppress("UNCHECKED_CAST")
        val json = content["application/json"] as? Map<String, Any?>
            ?: error("openapi.yaml の $method $path $status に application/json がありません")
        @Suppress("UNCHECKED_CAST")
        return json["schema"] as Map<String, Any?>
    }

    /** 実レスポンス JSON をスキーマと突合し、違反の一覧を返す (空なら適合) */
    fun validate(element: JsonElement, schema: Map<String, Any?>, location: String = "$"): List<String> {
        val errors = mutableListOf<String>()
        validateInto(element, schema, location, errors)
        return errors
    }

    private fun validateInto(
        element: JsonElement,
        schema: Map<String, Any?>,
        location: String,
        errors: MutableList<String>
    ) {
        (schema["\$ref"] as? String)?.let {
            validateInto(element, resolvePointer(it), location, errors)
            return
        }

        val types = when (val type = schema["type"]) {
            null -> null // type なし (geometry / value: {} 等の任意値) は何でも受け入れる
            is String -> listOf(type)
            is List<*> -> type.map { it as String }
            else -> error("$location: 未対応の type 表現です: $type (OpenApiSpecSupport を拡張すること)")
        }
        if (types != null && types.none { matchesType(element, it) }) {
            errors += "$location: 型が契約と一致しません (期待: $types, 実際: ${describe(element)})"
            return
        }
        if (element is JsonNull) return // null 許容は上の type 検査で判定済み

        (schema["enum"] as? List<*>)?.let { allowed ->
            if (element is JsonPrimitive && element.content !in allowed.map { it.toString() }) {
                errors += "$location: enum 外の値です (許容: $allowed, 実際: ${element.content})"
            }
        }

        if (element is JsonObject) {
            @Suppress("UNCHECKED_CAST")
            val required = schema["required"] as? List<String> ?: emptyList()
            for (field in required) {
                if (field !in element) errors += "$location: 必須フィールド '$field' がありません"
            }
            @Suppress("UNCHECKED_CAST")
            val properties = schema["properties"] as? Map<String, Any?> ?: emptyMap()
            for ((name, subschema) in properties) {
                val value = element[name] ?: continue
                @Suppress("UNCHECKED_CAST")
                validateInto(value, subschema as Map<String, Any?>, "$location.$name", errors)
            }
        }

        if (element is JsonArray) {
            @Suppress("UNCHECKED_CAST")
            val items = schema["items"] as? Map<String, Any?> ?: return
            element.forEachIndexed { index, item ->
                validateInto(item, items, "$location[$index]", errors)
            }
        }
    }

    private fun matchesType(element: JsonElement, type: String): Boolean = when (type) {
        "null" -> element is JsonNull
        "object" -> element is JsonObject
        "array" -> element is JsonArray
        "string" -> element is JsonPrimitive && element !is JsonNull && element.isString
        "boolean" -> element is JsonPrimitive && !element.isString && element.booleanOrNull != null
        "integer" -> element is JsonPrimitive && !element.isString && element.longOrNull != null
        "number" -> element is JsonPrimitive && !element.isString && element.doubleOrNull != null
        else -> error("未対応の type です: $type (OpenApiSpecSupport を拡張すること)")
    }

    private fun describe(element: JsonElement): String = when (element) {
        is JsonNull -> "null"
        is JsonObject -> "object"
        is JsonArray -> "array"
        is JsonPrimitive -> if (element.isString) "string" else "number/boolean"
    }

    /** "#/components/..." 形式の内部参照を解決する */
    private fun resolvePointer(ref: String): Map<String, Any?> {
        require(ref.startsWith("#/")) { "内部参照のみ対応しています: $ref" }
        var node: Any? = document
        for (segment in ref.removePrefix("#/").split("/")) {
            @Suppress("UNCHECKED_CAST")
            node = (node as? Map<String, Any?>)?.get(segment)
                ?: error("openapi.yaml 内で参照 $ref を解決できません (segment: $segment)")
        }
        @Suppress("UNCHECKED_CAST")
        return node as Map<String, Any?>
    }
}
