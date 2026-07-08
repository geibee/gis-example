package gis.example.routes

import gis.example.ApiException
import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

// 宣言 format と実体 (マジックバイト) の照合仕様 (issue #19)。
// HTTP 経由の 400 応答は ImportJobIntegrationTest が検証する
class ImportUploadValidationTest {

    private val zipHeader = byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x14, 0x00)
    private val emptyZipHeader = byteArrayOf(0x50, 0x4B, 0x05, 0x06)

    private fun assertRejected(header: ByteArray, format: String) {
        val exc = assertFailsWith<ApiException> { validateUploadMatchesFormat(header, format) }
        assertEquals(HttpStatusCode.BadRequest, exc.status)
    }

    @Test
    fun `shapefile は zip マジックバイトのみ受け付ける`() {
        validateUploadMatchesFormat(zipHeader, "shapefile")
        assertRejected("""{"type": "FeatureCollection"}""".toByteArray(), "shapefile")
        assertRejected(emptyZipHeader, "shapefile") // 空 zip はエントリなし = 実体なし
        assertRejected(ByteArray(0), "shapefile")
    }

    @Test
    fun `geojson は BOM と空白を除いた先頭が JSON 開始文字であること`() {
        validateUploadMatchesFormat("""{"type": "FeatureCollection", "features": []}""".toByteArray(), "geojson")
        validateUploadMatchesFormat("[]".toByteArray(), "geojson")
        validateUploadMatchesFormat("﻿  \n\t{".toByteArray(Charsets.UTF_8), "geojson")
        assertRejected(zipHeader, "geojson") // geojson 宣言で zip 実体 (偽装拡張子)
        assertRejected("<gml></gml>".toByteArray(), "geojson")
        assertRejected(ByteArray(0), "geojson")
    }

    @Test
    fun `XML 系形式は先頭タグを要求し zip 実体を拒否する`() {
        for (format in listOf("gml", "kml", "gpx")) {
            validateUploadMatchesFormat("﻿<?xml version=\"1.0\"?><root/>".toByteArray(Charsets.UTF_8), format)
            assertRejected(zipHeader, format)
            assertRejected("{}".toByteArray(), format)
        }
    }
}
