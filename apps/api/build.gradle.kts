plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    application
}

group = "gis.example"
version = "0.1.0"

application {
    mainClass.set("gis.example.ApplicationKt")
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // fail-closed: 警告を残したままマージさせない
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    implementation("io.ktor:ktor-server-core-jvm:2.3.12")
    implementation("io.ktor:ktor-server-netty-jvm:2.3.12")
    implementation("io.ktor:ktor-server-auth-jvm:2.3.12")
    implementation("io.ktor:ktor-server-auth-jwt-jvm:2.3.12")
    implementation("io.ktor:ktor-server-call-logging-jvm:2.3.12")
    // requestId (callId) の受入・生成・応答ヘッダ反映 (Observability.kt、MDC で全ログ行へ伝播)
    implementation("io.ktor:ktor-server-call-id-jvm:2.3.12")
    implementation("io.ktor:ktor-server-cors-jvm:2.3.12")
    // CloudFront/ALB 背後で X-Forwarded-* を解釈する (ForwardedHeaders.kt、TRUSTED_PROXY_COUNT で有効化)
    implementation("io.ktor:ktor-server-forwarded-header-jvm:2.3.12")
    implementation("io.ktor:ktor-server-status-pages-jvm:2.3.12")
    implementation("io.ktor:ktor-server-content-negotiation-jvm:2.3.12")
    implementation("io.ktor:ktor-serialization-kotlinx-json-jvm:2.3.12")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // アップロードの S3 保存 (UploadStorage.kt、UPLOAD_STORAGE=s3 で有効化。認証は既定チェーン)
    implementation("software.amazon.awssdk:s3:2.29.52")
    implementation("com.zaxxer:HikariCP:5.1.0")
    implementation("org.postgresql:postgresql:42.7.4")
    // スキーママイグレーション (versioned migration の SSoT は src/main/resources/db/migration)
    implementation("org.flywaydb:flyway-core:12.9.0")
    implementation("org.flywaydb:flyway-database-postgresql:12.9.0")
    implementation("ch.qos.logback:logback-classic:1.5.12")
    // LOG_FORMAT=json で構造化 JSON ログへ切替 (logback.xml。CloudWatch Logs Insights 前提)
    implementation("net.logstash.logback:logstash-logback-encoder:8.0")

    testImplementation(kotlin("test"))
    // 認証・認可の統合テストで HTTP 層 (PEP の配線) まで検証する
    testImplementation("io.ktor:ktor-server-test-host-jvm:2.3.12")
    // 契約突合テスト (OpenApiContractSyncTest / ContractResponseIntegrationTest) が
    // openapi.yaml をパースするための最小依存 (テスト限定。本体コードでは使わない)
    testImplementation("org.yaml:snakeyaml:2.3")
}

// test = 単体テストのみ (DB 不要、軽量ゲート scripts/verify.sh が実行)
tasks.test {
    useJUnitPlatform {
        excludeTags("integration")
    }
}

// integrationTest = PostGIS を要する統合テスト。
// DATABASE_URL / DATABASE_USER / DATABASE_PASSWORD で接続先を渡す
// (VERIFY_INTEGRATION=1 の scripts/verify.sh と CI の integration ジョブが実行)
val integrationTest by tasks.registering(Test::class) {
    description = "PostGIS を要する統合テスト (DATABASE_URL が必要)"
    group = "verification"
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    useJUnitPlatform {
        includeTags("integration")
    }
    // DB 状態に依存するため Gradle キャッシュで省略させない
    outputs.upToDateWhen { false }
    testLogging {
        events("passed", "failed", "skipped")
    }
}
