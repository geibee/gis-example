package feedback.service

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

fun main() {
    val connectorKey = requiredEnv("FEEDBACK_CONNECTOR_KEY")
    val descriptorUrl = requiredEnv("FEEDBACK_CONNECTOR_DESCRIPTOR_URL")
    validateConnectorInternalUrl(descriptorUrl, "FEEDBACK_CONNECTOR_DESCRIPTOR_URL")
    val descriptor = fetchConnectorManifest(descriptorUrl)
    val deliveryUrl = requiredEnv("FEEDBACK_CONNECTOR_DELIVERY_URL")
    val healthUrl = URI(descriptorUrl).resolve(descriptor.healthPath).toString()
    val configuredEvents = System.getenv("FEEDBACK_CONNECTOR_SUPPORTED_EVENTS")
        ?.split(',')?.map(String::trim)?.filter(String::isNotEmpty)
        ?: descriptor.supportedEvents
    validateConnectorManifest(connectorKey, configuredEvents, descriptor)
    val database = FeedbackDatabase.create(DatabaseSettings.fromEnv())
    try {
        database.migrate()
        database.registerConnectorInstallation(
            ConnectorInstallationInput(
                connectorKey = connectorKey,
                displayName = requiredEnv("FEEDBACK_CONNECTOR_DISPLAY_NAME"),
                manifestUrl = descriptorUrl,
                deliveryUrl = deliveryUrl,
                healthUrl = healthUrl,
                allowedHosts = (System.getenv("FEEDBACK_CONNECTOR_ALLOWED_HOSTS")
                    ?.split(',')?.map(String::trim)?.filter(String::isNotEmpty) ?: emptyList()),
                signingSecret = requiredEnv("FEEDBACK_CONNECTOR_SHARED_SECRET"),
                supportedEvents = configuredEvents,
                enabled = System.getenv("FEEDBACK_CONNECTOR_ENABLED") != "0",
                legacyDestinationRefs = System.getenv("FEEDBACK_CONNECTOR_LEGACY_REF_MAP")?.let { raw ->
                    serviceJson.parseToJsonElement(raw).jsonObject.mapValues { (_, value) -> value.jsonPrimitive.content }
                } ?: emptyMap()
            ),
            NotificationCipher.fromEnv()
        )
    } finally {
        database.close()
    }
}

internal fun fetchConnectorManifest(
    descriptorUrl: String,
    client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
): ConnectorManifestV1 {
    val response = client.send(
        HttpRequest.newBuilder(URI(descriptorUrl)).timeout(Duration.ofSeconds(15)).GET().build(),
        HttpResponse.BodyHandlers.ofString()
    )
    check(response.statusCode() == 200) { "connector descriptor の取得に失敗しました: HTTP ${response.statusCode()}" }
    return serviceJson.decodeFromString(ConnectorManifestV1.serializer(), response.body())
}

internal fun validateConnectorManifest(
    connectorKey: String,
    configuredEvents: List<String>,
    descriptor: ConnectorManifestV1
) {
    require(descriptor.kind == "manifest" && descriptor.protocolVersion == "1" &&
        "1" in descriptor.compatibleProtocolVersions) {
        "connector protocolVersion 1との互換性が必要です"
    }
    require(descriptor.connectorKey == connectorKey) { "connector key がdescriptorと一致しません" }
    require(configuredEvents.isNotEmpty() && configuredEvents.all { it in descriptor.supportedEvents }) {
        "configured event がconnector descriptorでサポートされていません"
    }
}
