import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { createJwtIssuer } from "./jwt.js";
import { authorizeExchange, BrokerPolicyError, type ClientPolicy } from "./policy.js";

const port = Number(process.env.FEEDBACK_BROKER_PORT ?? "8443");
const issuer = requiredEnv("FEEDBACK_BROKER_ISSUER").replace(/\/$/, "");
const audience = requiredEnv("FEEDBACK_BROKER_AUDIENCE");
const policies = JSON.parse(readFileSync(requiredEnv("FEEDBACK_BROKER_CLIENT_POLICIES_FILE"), "utf8")) as ClientPolicy[];
const signingPublicKeyFile = process.env.FEEDBACK_BROKER_SIGNING_PUBLIC_KEY_FILE;
const jwtIssuer = createJwtIssuer({
  issuer,
  audience,
  privateKeyPem: readFileSync(requiredEnv("FEEDBACK_BROKER_SIGNING_PRIVATE_KEY_FILE"), "utf8"),
  ...(signingPublicKeyFile ? { publicKeyPem: readFileSync(signingPublicKeyFile, "utf8") } : {}),
  maxLifetimeSeconds: Number(process.env.FEEDBACK_BROKER_MAX_LIFETIME_SECONDS ?? "300")
});

const server = createServer({
  cert: readFileSync(requiredEnv("FEEDBACK_BROKER_TLS_CERT_FILE")),
  key: readFileSync(requiredEnv("FEEDBACK_BROKER_TLS_KEY_FILE")),
  ca: readFileSync(requiredEnv("FEEDBACK_BROKER_CLIENT_CA_FILE")),
  requestCert: true,
  rejectUnauthorized: false,
  minVersion: "TLSv1.2"
}, async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/.well-known/jwks.json") {
      return sendJson(response, 200, jwtIssuer.jwks());
    }
    if (request.method !== "POST" || request.url !== "/v1/exchanges") {
      return sendProblem(response, 404, "route.not_found", "Not Found");
    }
    const socket = request.socket as TLSSocket;
    if (!socket.authorized) return sendProblem(response, 401, "client.authentication_failed", "Unauthorized");
    const certificate = socket.getPeerCertificate();
    const raw = await readJsonBody(request);
    const fingerprint256 = firstString(certificate.fingerprint256);
    const subjectCn = firstString(certificate.subject?.CN);
    const authorized = authorizeExchange({
      ...(fingerprint256 ? { fingerprint256 } : {}),
      ...(subjectCn ? { subjectCn } : {})
    }, raw, policies);
    const issued = jwtIssuer.issue(authorized.request);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Feedback-Broker-Client", authorized.clientId);
    return sendJson(response, 200, issued);
  } catch (error) {
    if (error instanceof BrokerPolicyError) return sendProblem(response, error.status, error.code, error.message);
    console.error("token exchange failed", error instanceof Error ? error.message : "unknown");
    return sendProblem(response, 500, "internal.error", "Internal Server Error");
  }
});

server.listen(port, "0.0.0.0", () => console.log(`feedback token broker listening on ${port}`));

// JWKSだけをservice networkへ公開する。token exchangeはこのportへ登録しない。
const jwksPort = Number(process.env.FEEDBACK_BROKER_JWKS_PORT ?? "8081");
createHttpServer((request, response) => {
  if (request.method === "GET" && request.url === "/.well-known/jwks.json") {
    return sendJson(response, 200, jwtIssuer.jwks());
  }
  return sendProblem(response, 404, "route.not_found", "Not Found");
}).listen(jwksPort, "0.0.0.0", () => console.log(`feedback token broker JWKS listening on ${jwksPort}`));

async function readJsonBody(request: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk :
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 65_536) throw new BrokerPolicyError(400, "request.too_large", "request bodyが大きすぎます");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BrokerPolicyError(400, "request.invalid_json", "JSONが不正です");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendProblem(response: ServerResponse, status: number, code: string, detail: string): void {
  response.writeHead(status, { "Content-Type": "application/problem+json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ type: `/problems/${code}`, title: detail, status, code }));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
