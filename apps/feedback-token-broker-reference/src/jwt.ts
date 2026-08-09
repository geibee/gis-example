import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import type { TokenExchangeRequest } from "./policy.js";

export type JwtIssuer = {
  issue(request: TokenExchangeRequest, nowEpochSeconds?: number): {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    expires_at: number;
  };
  jwks(): { keys: Record<string, unknown>[] };
};

export function createJwtIssuer(options: {
  issuer: string;
  audience: string;
  privateKeyPem: string;
  publicKeyPem?: string;
  maxLifetimeSeconds?: number;
}): JwtIssuer {
  const privateKey = createPrivateKey(options.privateKeyPem);
  const publicKey = options.publicKeyPem ? createPublicKey(options.publicKeyPem) : createPublicKey(privateKey);
  const exported = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const kid = createHash("sha256").update(JSON.stringify(exported)).digest("base64url").slice(0, 24);
  const jwk = { ...exported, kid, use: "sig", alg: "RS256" };
  const maxLifetime = Math.min(options.maxLifetimeSeconds ?? 300, 300);
  if (maxLifetime < 30) throw new Error("broker max lifetimeは30..300秒です");
  return {
    issue(request, nowEpochSeconds = Math.floor(Date.now() / 1000)) {
      const lifetime = Math.min(request.requested_lifetime_seconds ?? maxLifetime, maxLifetime, 300);
      const expiresAt = nowEpochSeconds + lifetime;
      const header = encodeJson({ alg: "RS256", typ: "JWT", kid });
      const payload = encodeJson({
        iss: options.issuer,
        sub: request.actor_sub,
        aud: options.audience,
        iat: nowEpochSeconds,
        exp: expiresAt,
        jti: randomUUID(),
        actor_issuer: request.actor_issuer,
        actor_sub: request.actor_sub,
        ...(request.actor_name ? { actor_name: request.actor_name } : {}),
        ...(request.actor_email ? { actor_email: request.actor_email } : {}),
        feedback_tenant: request.feedback_tenant,
        feedback_application: request.feedback_application,
        feedback_environment: request.feedback_environment,
        feedback_workspace: request.feedback_workspace,
        feedback_permissions: request.feedback_permissions
      });
      const signingInput = `${header}.${payload}`;
      const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
      return {
        access_token: `${signingInput}.${signature}`,
        token_type: "Bearer" as const,
        expires_in: lifetime,
        expires_at: expiresAt
      };
    },
    jwks: () => ({ keys: [jwk] })
  };
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
