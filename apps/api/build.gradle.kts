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
    implementation("io.ktor:ktor-server-call-logging-jvm:2.3.12")
    implementation("io.ktor:ktor-server-cors-jvm:2.3.12")
    implementation("io.ktor:ktor-server-status-pages-jvm:2.3.12")
    implementation("io.ktor:ktor-server-content-negotiation-jvm:2.3.12")
    implementation("io.ktor:ktor-serialization-kotlinx-json-jvm:2.3.12")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.zaxxer:HikariCP:5.1.0")
    implementation("org.postgresql:postgresql:42.7.4")
    implementation("ch.qos.logback:logback-classic:1.5.12")

    testImplementation(kotlin("test"))
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
