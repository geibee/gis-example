// 分析ジョブ (app.analysis_jobs) の作成・claim・実行と結果セット/結果テーブルの登録

package gis.example

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.sql.Connection
import java.sql.PreparedStatement
import java.time.OffsetDateTime

fun Database.createAnalysisJob(request: AnalysisJobRequest): AnalysisJobDto {
    val projectId = request.projectId ?: defaultProjectId()
    val normalizedRequest = request.copy(
        projectId = projectId,
        conditionQuery = request.conditionQuery?.copy(projectId = projectId)
    )
    val criteriaJson = databaseJson.encodeToString(normalizedRequest)
    val name = request.name?.takeIf { it.isNotBlank() } ?: "Analysis ${OffsetDateTime.now()}"
    return dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            INSERT INTO app.analysis_jobs (project_id, name, criteria)
            VALUES (?::uuid, ?, ?::jsonb)
            RETURNING id::text
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.setString(2, name)
            stmt.setString(3, criteriaJson)
            stmt.executeQuery().use { rs ->
                rs.next()
                getAnalysisJob(rs.getString(1)) ?: error("Created analysis job disappeared")
            }
        }
    }
}

fun Database.getAnalysisJob(id: String): AnalysisJobDto? = dataSource.connection.use { connection ->
    connection.prepareStatement(
        """
        SELECT id::text, project_id::text, name, criteria::text, status, error_message,
               result_layer_id::text, result_set_id::text, result_count,
               created_at::text, started_at::text, finished_at::text
        FROM app.analysis_jobs
        WHERE id = ?::uuid
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, id)
        stmt.executeQuery().use { rs ->
            if (!rs.next()) null else rs.toAnalysisJobDto()
        }
    }
}

// pending の分析ジョブを 1 件 claim する (worker-gis と同じ FOR UPDATE SKIP LOCKED 方式)。
// claim は独立トランザクションで確定するため、実行中にプロセスが落ちたジョブは running のまま残る
fun Database.claimPendingAnalysisJob(): ClaimedAnalysisJob? = dataSource.connection.use { connection ->
    connection.prepareStatement(
        """
        UPDATE app.analysis_jobs
        SET status = 'running', started_at = now(), error_message = NULL
        WHERE id = (
            SELECT id
            FROM app.analysis_jobs
            WHERE status = 'pending'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        RETURNING id::text, project_id::text, name, criteria::text
        """.trimIndent()
    ).use { stmt ->
        stmt.executeQuery().use { rs ->
            if (!rs.next()) {
                null
            } else {
                ClaimedAnalysisJob(
                    id = rs.getString(1),
                    projectId = rs.getString(2),
                    name = rs.getString(3),
                    criteriaJson = rs.getString(4)
                )
            }
        }
    }
}

// worker-gis の取込ジョブと同様に、実行中にプロセスが落ちて running のまま残った
// 分析ジョブをリース期限超過で pending へ戻す
fun Database.requeueStaleAnalysisJobs(maxAgeSeconds: Long): Int = dataSource.connection.use { connection ->
    connection.prepareStatement(
        """
        UPDATE app.analysis_jobs
        SET status = 'pending', started_at = NULL,
            error_message = concat('実行中のまま ', ?::text, ' 秒を超えたため再キュー')
        WHERE status = 'running'
          AND started_at < now() - make_interval(secs => ?::double precision)
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, maxAgeSeconds.toString())
        stmt.setLong(2, maxAgeSeconds)
        stmt.executeUpdate()
    }
}

// claim 済み分析ジョブを実行する。結果テーブル作成・レイヤ登録・ジョブ状態更新を
// 1 トランザクションで確定し、例外時は failed を記録する (呼び出し側へは投げない)
fun Database.executeClaimedAnalysisJob(job: ClaimedAnalysisJob) {
    try {
        val request = databaseJson.decodeFromString<AnalysisJobRequest>(job.criteriaJson)
        val operation = request.operation?.takeIf { it.isNotBlank() }?.lowercase() ?: "and_filter"
        val outcome = dataSource.connection.use { connection ->
            val previousAutoCommit = connection.autoCommit
            connection.autoCommit = false
            try {
                setLocalStatementTimeout(connection, heavyStatementTimeoutMillis)
                val outcome = when (operation) {
                    "condition_search" -> executeConditionSearchAnalysisJob(connection, job, request)
                    "and_filter" -> executeAndFilterAnalysisJob(connection, job, request)
                    else -> throw IllegalArgumentException("Unsupported analysis operation: ${request.operation}")
                }
                connection.prepareStatement(
                    """
                    UPDATE app.analysis_jobs
                    SET status = 'succeeded',
                        result_layer_id = ?::uuid,
                        result_set_id = ?::uuid,
                        result_count = ?,
                        finished_at = now()
                    WHERE id = ?::uuid
                    """.trimIndent()
                ).use { stmt ->
                    setNullableUuidString(stmt, 1, outcome.resultLayerId)
                    setNullableUuidString(stmt, 2, outcome.resultSetId)
                    stmt.setLong(3, outcome.resultCount)
                    stmt.setString(4, job.id)
                    stmt.executeUpdate()
                }
                connection.commit()
                outcome
            } catch (exc: Exception) {
                connection.rollback()
                throw exc
            } finally {
                connection.autoCommit = previousAutoCommit
            }
        }
        databaseLogger.info(
            "Analysis job {} succeeded (layer={}, resultSet={}, count={})",
            job.id, outcome.resultLayerId, outcome.resultSetId, outcome.resultCount
        )
    } catch (exc: Exception) {
        markAnalysisJobFailed(job.id, exc)
    }
}

private fun Database.executeConditionSearchAnalysisJob(
    connection: Connection,
    job: ClaimedAnalysisJob,
    request: AnalysisJobRequest
): AnalysisJobOutcome {
    val conditionQuery = request.conditionQuery
        ?: throw IllegalArgumentException("conditionQuery is required for condition_search")
    val projectId = conditionQuery.projectId?.trim()?.takeIf { it.isNotEmpty() } ?: job.projectId
    if (projectId != job.projectId) {
        throw IllegalArgumentException("Condition query project does not match analysis project")
    }

    val layers = listLayers(projectId)
    val layersById = layers.associateBy { it.id }
    val targetLayerIds = conditionQuery.targetLayerIds
        .mapNotNull { it.trim().takeIf(String::isNotEmpty) }
        .distinct()
    if (targetLayerIds.isEmpty()) {
        throw IllegalArgumentException("conditionQuery.targetLayerIds is required")
    }
    val targetLayers = targetLayerIds.map { layerId ->
        layersById[layerId]
            ?: throw IllegalArgumentException("Target layer does not exist in project: $layerId")
    }
    validateConditionSearchConditions(conditionQuery, layersById)

    val summary = conditionSearchSummary(conditionQuery.keyword, conditionLabels(conditionQuery.conditions))
    val emptyBusinessLinksJson = databaseJson.encodeToString(BusinessLinksDto())
    val resultSetId = insertResultSet(connection, projectId, job.name, conditionQuery)
    val baseTableName = "result_${job.id.replace("-", "").take(24)}"

    var representativeLayerId: String? = null
    var totalCount = 0L
    targetLayers.forEachIndexed { index, target ->
        val childTable = "%s_%02d".format(baseTableName, index + 1)
        val resultRef = "${quoteIdent("gis_data")}.${quoteIdent(childTable)}"
        val targetRef = "${quoteIdent(target.schemaName)}.${quoteIdent(target.tableName)}"
        val fragment = conditionSearchFilters(target, layers, layersById, projectId, conditionQuery, conditionQuery.limit)
        val sourceSelect = selectableSourceColumns(connection, target)
            .joinToString(",\n                ") { "t.${quoteIdent(it)}" }

        connection.createStatement().use { stmt ->
            stmt.execute("DROP TABLE IF EXISTS $resultRef")
            // CREATE TABLE AS はユーティリティ文でバインドパラメータを使えないため、
            // スキーマだけ WHERE FALSE で作り、本体は INSERT ... SELECT で流し込む
            stmt.execute(
                """
                CREATE TABLE $resultRef AS
                SELECT
                    $sourceSelect,
                    NULL::uuid AS source_layer_id,
                    t.${quoteIdent(target.featureIdColumn)}::text AS source_feature_id,
                    NULL::text AS matched_condition_summary,
                    NULL::jsonb AS matched_business_links
                FROM $targetRef AS t
                WHERE FALSE
                """.trimIndent()
            )
        }
        connection.prepareStatement(
            """
            INSERT INTO $resultRef
            SELECT
                $sourceSelect,
                ?::uuid AS source_layer_id,
                t.${quoteIdent(target.featureIdColumn)}::text AS source_feature_id,
                ?::text AS matched_condition_summary,
                ?::jsonb AS matched_business_links
            FROM $targetRef AS t
            WHERE ${fragment.sql}
            """.trimIndent()
        ).use { stmt ->
            var bindIndex = 1
            stmt.setString(bindIndex++, target.id)
            stmt.setString(bindIndex++, summary)
            stmt.setString(bindIndex++, emptyBusinessLinksJson)
            for (binder in fragment.binders) {
                binder(stmt, bindIndex++)
            }
            stmt.executeUpdate()
        }
        normalizeGeneratedTable(connection, "gis_data", childTable, "geom")
        val count = countRows(connection, resultRef)
        totalCount += count
        val layerId = insertLayerMetadata(
            connection = connection,
            projectId = projectId,
            name = "${target.name} ${count}件",
            tableName = childTable,
            sourceSrid = 3857,
            isResult = true,
            layerRole = "generic",
            resultSetId = resultSetId,
            sourceLayerId = target.id
        )
        if (representativeLayerId == null) {
            representativeLayerId = layerId
        }
    }
    return AnalysisJobOutcome(representativeLayerId, resultSetId, totalCount)
}

private fun Database.executeAndFilterAnalysisJob(
    connection: Connection,
    job: ClaimedAnalysisJob,
    request: AnalysisJobRequest
): AnalysisJobOutcome {
    val targetLayerId = request.targetLayerId?.takeIf { it.isNotBlank() }
        ?: throw IllegalArgumentException("targetLayerId is required")
    val referencedLayerIds = buildSet {
        add(targetLayerId)
        request.attributeConditions.forEach { add(it.layerId) }
        request.spatialConditions.forEach { add(it.layerId) }
    }
    val layers = referencedLayerIds.associateWith { layerId ->
        getLayerInConnection(connection, layerId)
            ?: throw IllegalArgumentException("Layer not found: $layerId")
    }
    layers.values.forEach { layer ->
        if (layer.projectId != job.projectId) {
            throw IllegalArgumentException("Layer ${layer.id} does not belong to analysis project")
        }
    }
    val target = layers.getValue(targetLayerId)

    val filters = mutableListOf<String>()
    val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
    request.attributeConditions
        .filter { it.layerId == target.id }
        .forEach { filters.add(andFilterAttributePredicate("t", it, binders)) }

    val nonTargetLayerIds = buildSet {
        request.attributeConditions.mapNotNullTo(this) { it.layerId.takeIf { layerId -> layerId != target.id } }
        request.spatialConditions.mapTo(this) { it.layerId }
    }
    for (layerId in nonTargetLayerIds.sorted()) {
        val otherLayer = layers.getValue(layerId)
        val inner = mutableListOf<String>()
        request.spatialConditions
            .filter { it.layerId == layerId }
            .forEach { condition ->
                val spatial = spatialPredicateSql(
                    "t.${quoteIdent(target.geometryColumn)}",
                    "o.${quoteIdent(otherLayer.geometryColumn)}",
                    condition.operator.trim().lowercase(),
                    condition.distanceMeters
                )
                inner.add(spatial.sql)
                binders.addAll(spatial.binders)
            }
        request.attributeConditions
            .filter { it.layerId == layerId }
            .forEach { inner.add(andFilterAttributePredicate("o", it, binders)) }
        if (inner.isEmpty()) inner.add("TRUE")
        filters.add(
            """
            EXISTS (
                SELECT 1
                FROM ${quoteIdent(otherLayer.schemaName)}.${quoteIdent(otherLayer.tableName)} AS o
                WHERE ${inner.joinToString(" AND ")}
            )
            """.trimIndent()
        )
    }
    val whereSql = if (filters.isEmpty()) "TRUE" else filters.joinToString(" AND ")

    val tableName = "result_${job.id.replace("-", "").take(24)}"
    val resultRef = "${quoteIdent("gis_data")}.${quoteIdent(tableName)}"
    val targetRef = "${quoteIdent(target.schemaName)}.${quoteIdent(target.tableName)}"
    connection.createStatement().use { stmt ->
        stmt.execute("DROP TABLE IF EXISTS $resultRef")
        stmt.execute("CREATE TABLE $resultRef AS SELECT t.* FROM $targetRef AS t WHERE FALSE")
    }
    connection.prepareStatement(
        "INSERT INTO $resultRef SELECT t.* FROM $targetRef AS t WHERE $whereSql"
    ).use { stmt ->
        var bindIndex = 1
        for (binder in binders) {
            binder(stmt, bindIndex++)
        }
        stmt.executeUpdate()
    }
    normalizeGeneratedTable(connection, "gis_data", tableName, "geom")
    val count = countRows(connection, resultRef)
    val layerId = insertLayerMetadata(
        connection = connection,
        projectId = job.projectId,
        name = job.name,
        tableName = tableName,
        sourceSrid = 3857,
        isResult = true,
        layerRole = "generic"
    )
    return AnalysisJobOutcome(layerId, null, count)
}

// and_filter (旧形式) の属性述語。worker-gis の attribute_predicate と同じ意味論を保つ
private fun Database.andFilterAttributePredicate(
    alias: String,
    condition: AttributeConditionDto,
    binders: MutableList<(PreparedStatement, Int) -> Unit>
): String {
    val column = "$alias.${quoteIdent(condition.field)}"
    val operator = condition.operator.uppercase().let { if (it == "!=") "<>" else it }
    return when (operator) {
        "IS NULL" -> "$column IS NULL"
        "LIKE" -> {
            val value = condition.value?.jsonPrimitive?.contentOrNull
                ?: throw IllegalArgumentException("LIKE operator requires a value")
            binders.add { stmt, index -> stmt.setString(index, value) }
            "$column::text LIKE ?"
        }
        "IN" -> {
            val values = condition.values?.filter { it.isNotEmpty() }
                ?: throw IllegalArgumentException("IN operator requires values")
            if (values.isEmpty()) throw IllegalArgumentException("IN operator requires values")
            binders.add { stmt, index -> stmt.setArray(index, stmt.connection.createArrayOf("text", values.toTypedArray())) }
            "$column::text = ANY(?::text[])"
        }
        "=", "<>", "<", "<=", ">", ">=" -> {
            val value = condition.value
            if (value == null || value is JsonNull) {
                throw IllegalArgumentException("${condition.operator} operator requires a value")
            }
            val primitive = value.jsonPrimitive
            val boolValue = primitive.booleanOrNull
            val longValue = primitive.longOrNull
            val doubleValue = primitive.doubleOrNull
            when {
                primitive.isString -> binders.add { stmt, index -> stmt.setString(index, primitive.content) }
                boolValue != null -> binders.add { stmt, index -> stmt.setBoolean(index, boolValue) }
                longValue != null -> binders.add { stmt, index -> stmt.setLong(index, longValue) }
                doubleValue != null -> binders.add { stmt, index -> stmt.setDouble(index, doubleValue) }
                else -> binders.add { stmt, index -> stmt.setString(index, primitive.content) }
            }
            "$column $operator ?"
        }
        else -> throw IllegalArgumentException("Unsupported attribute operator: ${condition.operator}")
    }
}

// 結果テーブルへ引き継ぐ元レイヤの列。結果メタデータ列と衝突する列は除外する
private fun Database.selectableSourceColumns(connection: Connection, layer: LayerDto): List<String> {
    val metadataColumns = setOf("source_layer_id", "source_feature_id", "matched_condition_summary", "matched_business_links")
    val columns = connection.prepareStatement(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, layer.schemaName)
        stmt.setString(2, layer.tableName)
        stmt.executeQuery().use { rs ->
            buildList {
                while (rs.next()) {
                    val column = rs.getString("column_name")
                    if (column !in metadataColumns) add(column)
                }
            }
        }
    }
    if (columns.isEmpty()) {
        throw IllegalArgumentException("Layer ${layer.id} has no selectable columns")
    }
    return columns
}

private fun Database.insertResultSet(
    connection: Connection,
    projectId: String,
    name: String,
    conditionQuery: ConditionQueryDto
): String = connection.prepareStatement(
    """
    INSERT INTO app.result_sets (project_id, name, criteria)
    VALUES (?::uuid, ?, ?::jsonb)
    RETURNING id::text
    """.trimIndent()
).use { stmt ->
    stmt.setString(1, projectId)
    stmt.setString(2, name)
    stmt.setString(3, databaseJson.encodeToString(conditionQuery))
    stmt.executeQuery().use { rs ->
        rs.next()
        rs.getString(1)
    }
}

private fun Database.countRows(connection: Connection, tableRef: String): Long =
    connection.createStatement().use { stmt ->
        stmt.executeQuery("SELECT count(*)::bigint FROM $tableRef").use { rs ->
            rs.next()
            rs.getLong(1)
        }
    }

private fun Database.markAnalysisJobFailed(jobId: String, exc: Exception) {
    val message = (exc.message ?: exc.toString()).take(4000)
    try {
        dataSource.connection.use { connection ->
            connection.prepareStatement(
                """
                UPDATE app.analysis_jobs
                SET status = 'failed', error_message = ?, finished_at = now()
                WHERE id = ?::uuid
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, message)
                stmt.setString(2, jobId)
                stmt.executeUpdate()
            }
        }
    } catch (updateExc: Exception) {
        databaseLogger.error("Failed to mark analysis job $jobId as failed", updateExc)
    }
    databaseLogger.warn("Analysis job {} failed: {}", jobId, message)
}
