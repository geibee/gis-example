import org.gradle.jvm.application.tasks.CreateStartScripts

plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    application
}

group = "feedback.service"
version = "0.1.0-alpha.1"

application {
    mainClass.set("feedback.service.ApplicationKt")
}

val notificationWorkerStartScripts by tasks.registering(CreateStartScripts::class) {
    applicationName = "feedback-notification-worker"
    mainClass.set("feedback.service.NotificationWorkerMainKt")
    outputDir = layout.buildDirectory.dir("scripts-notification-worker").get().asFile
    classpath = tasks.startScripts.get().classpath
}

val bootstrapStartScripts by tasks.registering(CreateStartScripts::class) {
    applicationName = "feedback-bootstrap"
    mainClass.set("feedback.service.BootstrapMainKt")
    outputDir = layout.buildDirectory.dir("scripts-bootstrap").get().asFile
    classpath = tasks.startScripts.get().classpath
}

val retentionWorkerStartScripts by tasks.registering(CreateStartScripts::class) {
    applicationName = "feedback-retention-worker"
    mainClass.set("feedback.service.RetentionWorkerMainKt")
    outputDir = layout.buildDirectory.dir("scripts-retention-worker").get().asFile
    classpath = tasks.startScripts.get().classpath
}

val exportWorkerStartScripts by tasks.registering(CreateStartScripts::class) {
    applicationName = "feedback-export-worker"
    mainClass.set("feedback.service.ExportWorkerMainKt")
    outputDir = layout.buildDirectory.dir("scripts-export-worker").get().asFile
    classpath = tasks.startScripts.get().classpath
}

// 旧Web GISコピーCLIはGIS repositoryだけの別配布物にし、ServiceのinstallDist/imageへ混ぜない。
if (file("src/main/kotlin/feedback/service/LegacyMigrationMain.kt").isFile) {
    val legacyMigrationStartScripts by tasks.registering(CreateStartScripts::class) {
        applicationName = "feedback-legacy-migration"
        mainClass.set("feedback.service.LegacyMigrationMainKt")
        outputDir = layout.buildDirectory.dir("scripts-legacy-migration").get().asFile
        classpath = tasks.startScripts.get().classpath
    }
    distributions.create("legacyMigration") {
        distributionBaseName.set("feedback-legacy-migration")
        contents {
            into("bin") {
                from(legacyMigrationStartScripts)
                filePermissions { unix("rwxr-xr-x") }
            }
            into("lib") {
                from(tasks.jar)
                from(configurations.runtimeClasspath)
            }
        }
    }
}

distributions {
    main {
        contents {
            into("bin") {
                from(notificationWorkerStartScripts)
                filePermissions { unix("rwxr-xr-x") }
            }
            into("bin") {
                from(bootstrapStartScripts)
                filePermissions { unix("rwxr-xr-x") }
            }
            into("bin") {
                from(retentionWorkerStartScripts)
                filePermissions { unix("rwxr-xr-x") }
            }
            into("bin") {
                from(exportWorkerStartScripts)
                filePermissions { unix("rwxr-xr-x") }
            }
        }
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        allWarningsAsErrors.set(true)
    }
}

sourceSets["main"].kotlin.srcDir("../../contracts/feedback/kotlin")

dependencies {
    implementation("io.ktor:ktor-server-core-jvm:2.3.12")
    implementation("io.ktor:ktor-server-netty-jvm:2.3.12")
    implementation("io.ktor:ktor-server-auth-jvm:2.3.12")
    implementation("io.ktor:ktor-server-auth-jwt-jvm:2.3.12")
    implementation("io.ktor:ktor-server-call-id-jvm:2.3.12")
    implementation("io.ktor:ktor-server-call-logging-jvm:2.3.12")
    implementation("io.ktor:ktor-server-content-negotiation-jvm:2.3.12")
    implementation("io.ktor:ktor-server-status-pages-jvm:2.3.12")
    implementation("io.ktor:ktor-serialization-kotlinx-json-jvm:2.3.12")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.zaxxer:HikariCP:5.1.0")
    implementation("org.postgresql:postgresql:42.7.4")
    implementation("org.flywaydb:flyway-core:12.9.0")
    implementation("org.flywaydb:flyway-database-postgresql:12.9.0")
    implementation("software.amazon.awssdk:s3:2.29.52")
    implementation("ch.qos.logback:logback-classic:1.5.12")

    testImplementation(kotlin("test"))
    testImplementation("io.ktor:ktor-server-test-host-jvm:2.3.12")
    testImplementation("org.yaml:snakeyaml:2.3")
}

tasks.test {
    useJUnitPlatform {
        excludeTags("integration")
    }
}

val integrationTest by tasks.registering(Test::class) {
    description = "通常 PostgreSQL に対する独立 Feedback Service 統合テスト"
    group = "verification"
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    useJUnitPlatform {
        includeTags("integration")
    }
    outputs.upToDateWhen { false }
    testLogging {
        events("passed", "failed", "skipped")
    }
}
