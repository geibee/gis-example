package feedback.service

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MigrationBoundaryTest {
    @Test
    fun `専用 migration は Web GIS と PostGIS を参照しない`() {
        val migration = Files.readString(
            Path.of("src", "main", "resources", "db", "migration", "V1__feedback_baseline.sql")
        ).lowercase()
        listOf("postgis", "gis_data", "app.projects", "app.users", "geometry(", "st_makevalid", "st_transform").forEach { forbidden ->
            assertFalse(forbidden in migration, "専用 migration に禁止された依存があります: $forbidden")
        }
        listOf(
            "feedback.tenants",
            "feedback.applications",
            "feedback.application_environments",
            "feedback.workspaces",
            "feedback.workspace_memberships",
            "feedback.review_sessions",
            "feedback.feedback_threads",
            "feedback.feedback_messages",
            "feedback.review_evidence",
            "feedback.audit_logs",
            "feedback.idempotency_records",
            "feedback.rate_limit_counters"
        ).forEach { required -> assertTrue(required in migration, "専用 table が不足しています: $required") }
    }
}
