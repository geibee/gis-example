// ルート層へ渡す依存の束 (軽量 DI)。DI フレームワークは使わず、
// Application.module が 1 度だけ組み立てて各 routes 拡張関数へ引数で渡す。
// 新しい依存 (設定値・クライアント等) はここへフィールドを足し、必要な routes だけが参照する
package gis.example.routes

import gis.example.Database
import gis.example.UploadStorage
import java.nio.file.Path

data class AppDependencies(
    val db: Database,
    // multipart 受信のステージング先 (ローカル FS)。保存先の正はあくまで uploadStorage
    val uploadDir: Path,
    // アップロードの保存先 (local | s3)。参照文字列の形式は UploadStorage.kt を参照
    val uploadStorage: UploadStorage,
    val apiPublicUrl: String,
    val maxUploadBytes: Long
)
