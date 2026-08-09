// @vitest-environment node
import { describe, expect, it } from "vitest";
import { signFixtureSession, verifyFixtureSession } from "./session.js";

describe("fixture HttpOnly session署名", () => {
  it("署名と期限を検証し改ざん・期限超過を拒否する", () => {
    const session = { actorIssuer: "https://id.example", actorSubject: "user-1", displayName: "User", expiresAt: 200 };
    const signed = signFixtureSession(session, "test-secret");
    expect(verifyFixtureSession(signed, "test-secret", 100)).toEqual(session);
    expect(verifyFixtureSession(`${signed}x`, "test-secret", 100)).toBeNull();
    expect(verifyFixtureSession(signed, "test-secret", 201)).toBeNull();
  });
});
