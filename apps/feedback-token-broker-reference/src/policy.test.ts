import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createJwtIssuer } from "./jwt.js";
import { authorizeExchange, BrokerPolicyError, type ClientPolicy } from "./policy.js";

const policy: ClientPolicy = {
  id: "fixture-host",
  subjectCn: "fixture-host",
  actorIssuers: ["https://id.example"],
  tenants: ["tenant-1"],
  applications: ["inventory"],
  environments: ["test"],
  workspaces: ["east"],
  permissions: ["feedback.read", "feedback.comment"]
};

const request = {
  actor_issuer: "https://id.example",
  actor_sub: "user-1",
  feedback_tenant: "tenant-1",
  feedback_application: "inventory",
  feedback_environment: "test",
  feedback_workspace: "east",
  feedback_permissions: ["feedback.read", "feedback.comment"] as const
};

describe("token broker policy", () => {
  it("mTLS clientのscope上限内だけを許可する", () => {
    const result = authorizeExchange({ subjectCn: "fixture-host" }, request, [policy]);
    expect(result.clientId).toBe("fixture-host");
    expect(result.request.feedback_workspace).toBe("east");
  });

  it.each([
    [{ subjectCn: "unknown" }, request, "client.unknown"],
    [{ subjectCn: "fixture-host" }, { ...request, feedback_workspace: "west" }, "scope.denied"],
    [{ subjectCn: "fixture-host" }, { ...request, feedback_permissions: ["feedback.admin"] }, "scope.permission_denied"]
  ] as const)("未知client・workspace越境・permission過剰要求を拒否する", (identity, input, code) => {
    expect(() => authorizeExchange(identity, input, [policy])).toThrowError(BrokerPolicyError);
    try {
      authorizeExchange(identity, input, [policy]);
    } catch (error) {
      expect((error as BrokerPolicyError).code).toBe(code);
    }
  });

  it("audience限定かつ300秒以内の既存claim名でJWTを発行する", () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const issuer = createJwtIssuer({
      issuer: "https://broker.example",
      audience: "feedback-service",
      privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      maxLifetimeSeconds: 300
    });
    const token = issuer.issue(authorizeExchange({ subjectCn: "fixture-host" }, request, [policy]).request, 1000);
    const claims = JSON.parse(Buffer.from(token.access_token.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims).toMatchObject({
      aud: "feedback-service",
      actor_issuer: "https://id.example",
      actor_sub: "user-1",
      feedback_tenant: "tenant-1",
      feedback_application: "inventory",
      feedback_environment: "test",
      feedback_workspace: "east",
      feedback_permissions: ["feedback.read", "feedback.comment"],
      iat: 1000,
      exp: 1300
    });
    expect(token.expires_in).toBe(300);
    expect(issuer.jwks().keys[0]).not.toHaveProperty("d");
  });
});
