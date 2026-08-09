import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function validator(name: string) {
  const schema = JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8"));
  return ajv.compile(schema);
}

describe("Feedback JSON Schema", () => {
  it("application manifestのrouteとparameter policyを検証する", () => {
    const validate = validator("application-manifest");
    expect(validate({
      schemaVersion: "1",
      applicationKey: "sample-app",
      displayName: "サンプル",
      manifestVersion: "1",
      routes: [{
        pageKey: "orders.detail",
        template: "/orders/{orderId}",
        label: "注文詳細",
        parameters: { orderId: { persistence: "hash" } }
      }]
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      schemaVersion: "1",
      applicationKey: "Invalid Key",
      displayName: "サンプル",
      manifestVersion: "1",
      routes: []
    })).toBe(false);
  });

  it("locationは生URLではなくmanifestで復元可能な構造だけを受ける", () => {
    const validate = validator("location");
    expect(validate({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}",
      pathParameters: { orderId: "A-1" },
      queryParameters: { tab: "history" }
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}?token=secret",
      pathParameters: { orderId: "A-1" }
    })).toBe(false);
  });

  it("targetの全variantと座標範囲を検証する", () => {
    const validate = validator("target");
    const targets = [
      { schemaVersion: "1", kind: "ui-element", elementKey: "save", relativeX: 0.5, relativeY: 0.5 },
      { schemaVersion: "1", kind: "screen-position", relativeX: 0, relativeY: 1 },
      {
        schemaVersion: "1",
        kind: "map-feature",
        provider: "maplibre",
        sourceKey: "parcels",
        featureKey: "P-1",
        longitude: 139.7,
        latitude: 35.6
      },
      { schemaVersion: "1", kind: "map-position", longitude: 139.7, latitude: 35.6 }
    ];
    for (const target of targets) expect(validate(target), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ schemaVersion: "1", kind: "map-position", longitude: 181, latitude: 0 })).toBe(false);
    expect(validate({ ...targets[0], unknown: true })).toBe(false);
  });

  it("webhookはversioned domain eventとactorを必須にする", () => {
    const validate = validator("webhook-event");
    const event = {
      schemaVersion: "1",
      eventId: "00000000-0000-4000-8000-000000000001",
      requestId: "request-0001",
      eventType: "feedback.thread.created.v1",
      occurredAt: "2026-08-09T00:00:00Z",
      tenantKey: "tenant-1",
      applicationKey: "sample-app",
      environmentKey: "production",
      externalWorkspaceKey: "workspace-1",
      sessionId: "00000000-0000-4000-8000-000000000002",
      threadId: "00000000-0000-4000-8000-000000000003",
      actor: { principalId: "issuer|subject" },
      deepLink: "https://app.example/orders/1?feedbackThread=1",
      evidenceUrl: "/feedback/v1/threads/00000000-0000-4000-8000-000000000003/evidence"
    };
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...event, eventType: "feedback.unknown.v1" })).toBe(false);
  });

  it("connector protocolはmanifest・delivery・resultと互換versionを固定する", () => {
    const localAjv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(localAjv);
    const eventSchema = JSON.parse(readFileSync(new URL("../schemas/webhook-event.schema.json", import.meta.url), "utf8"));
    localAjv.addSchema(eventSchema, "https://feedback.example/schemas/webhook-event.schema.json");
    const connectorSchema = JSON.parse(readFileSync(new URL("../schemas/connector-protocol.schema.json", import.meta.url), "utf8"));
    const validate = localAjv.compile(connectorSchema);
    const event = {
      schemaVersion: "1",
      eventId: "00000000-0000-4000-8000-000000000001",
      requestId: "request-1",
      eventType: "feedback.message.created.v1",
      occurredAt: "2026-08-09T00:00:00Z",
      tenantKey: "tenant-1",
      applicationKey: "sample-app",
      environmentKey: "production",
      externalWorkspaceKey: "workspace-1",
      sessionId: "00000000-0000-4000-8000-000000000002",
      threadId: "00000000-0000-4000-8000-000000000003",
      actor: { principalId: "issuer|subject" },
      deepLink: "https://app.example/review?feedbackThread=1"
    };
    expect(validate({
      kind: "manifest",
      protocolVersion: "1",
      compatibleProtocolVersions: ["1"],
      connectorKey: "teams",
      displayName: "Teams",
      supportedEvents: ["feedback.message.created.v1"],
      healthPath: "/health/ready"
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      kind: "delivery-request",
      protocolVersion: "1",
      deliveryId: "00000000-0000-4000-8000-000000000004",
      eventId: event.eventId,
      destinationRef: "review-channel",
      occurredAt: event.occurredAt,
      event
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      kind: "delivery-request",
      protocolVersion: "1",
      deliveryId: "00000000-0000-4000-8000-000000000004",
      eventId: event.eventId,
      destinationRef: "review-channel",
      occurredAt: event.occurredAt,
      event: { ...event, evidenceUrl: "/feedback/v1/evidence" }
    })).toBe(false);
    expect(validate({
      kind: "delivery-result",
      protocolVersion: "1",
      deliveryId: "00000000-0000-4000-8000-000000000004",
      status: "accepted",
      receivedAt: "2026-08-09T00:00:01Z"
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      kind: "delivery-request",
      protocolVersion: "2",
      deliveryId: "00000000-0000-4000-8000-000000000004",
      destinationRef: "review-channel",
      event
    })).toBe(false);
  });

  it("token exchange JWTはactorとFeedback scope claimを必須にする", () => {
    const validate = validator("token-exchange-jwt");
    const claims = {
      iss: "https://broker.example",
      sub: "user-1",
      aud: "feedback-service",
      iat: 1000,
      exp: 1300,
      jti: "00000000-0000-4000-8000-000000000001",
      actor_issuer: "https://id.example",
      actor_sub: "user-1",
      feedback_tenant: "tenant-1",
      feedback_application: "inventory",
      feedback_environment: "production",
      feedback_workspace: "east",
      feedback_permissions: ["feedback.read", "feedback.comment"]
    };
    expect(validate(claims), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...claims, feedback_permissions: ["host.admin"] })).toBe(false);
    const { actor_sub: _actorSubject, ...withoutActor } = claims;
    expect(validate(withoutActor)).toBe(false);
  });
});
