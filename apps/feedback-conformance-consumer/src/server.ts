import { createReadStream, readFileSync, statSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, normalize } from "node:path";
import { signFixtureSession, verifyFixtureSession } from "./session.js";

const port = Number(process.env.PORT ?? "8080");
const sessionSecret = requiredEnv("FIXTURE_SESSION_SIGNING_SECRET");
if (sessionSecret.length < 32) throw new Error("FIXTURE_SESSION_SIGNING_SECRET は 32 文字以上で指定してください");
const webhookSecret = requiredEnv("FEEDBACK_WEBHOOK_SIGNING_SECRET");
if (webhookSecret.length < 32) throw new Error("FEEDBACK_WEBHOOK_SIGNING_SECRET は 32 文字以上で指定してください");
const cookieName = "feedback_fixture_session";
const distDirectory = join(process.cwd(), "dist");
let webhookDeliveryCount = 0;
let lastWebhookEvent: unknown = null;

createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/fixture-webhook") {
      const body = await readBody(request, 65_536);
      const timestamp = singleHeader(request.headers["x-feedback-timestamp"]);
      const signature = singleHeader(request.headers["x-feedback-signature"]);
      const expected = `v1=${createHmac("sha256", webhookSecret).update(`${timestamp ?? ""}.${body}`).digest("hex")}`;
      if (!timestamp || !signature || !constantTimeEqual(signature, expected)) {
        return sendJson(response, 401, { code: "fixture.webhook_signature_invalid" });
      }
      lastWebhookEvent = JSON.parse(body);
      webhookDeliveryCount += 1;
      response.writeHead(204, { "Cache-Control": "no-store" });
      return response.end();
    }
    if (request.method === "GET" && request.url === "/fixture-webhook/status") {
      return sendJson(response, 200, { count: webhookDeliveryCount, lastEvent: lastWebhookEvent });
    }
    if (request.method === "POST" && request.url === "/fixture-auth/session") {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const signed = signFixtureSession({
        actorIssuer: requiredEnv("FIXTURE_ACTOR_ISSUER"),
        actorSubject: process.env.FIXTURE_ACTOR_SUBJECT ?? "fixture-user",
        displayName: process.env.FIXTURE_ACTOR_DISPLAY_NAME ?? "Fixture User",
        email: process.env.FIXTURE_ACTOR_EMAIL,
        expiresAt
      }, sessionSecret);
      const secure = process.env.FIXTURE_SECURE_COOKIE === "1" ? "; Secure" : "";
      response.writeHead(204, {
        "Set-Cookie": `${cookieName}=${signed}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${secure}`,
        "Cache-Control": "no-store"
      });
      return response.end();
    }
    if (request.method === "POST" && request.url === "/fixture-auth/feedback-token") {
      const session = verifyFixtureSession(readCookie(request, cookieName), sessionSecret);
      if (!session) return sendJson(response, 401, { code: "fixture.session_required" });
      const scope = await readJson(request) as Record<string, unknown>;
      const application = requiredString(scope, "applicationKey");
      const environment = requiredString(scope, "environmentKey");
      const workspace = requiredString(scope, "externalWorkspaceKey");
      const brokerResponse = await callBroker({
        actor_issuer: session.actorIssuer,
        actor_sub: session.actorSubject,
        ...(session.email ? { actor_email: session.email } : {}),
        actor_name: session.displayName,
        feedback_tenant: process.env.FIXTURE_FEEDBACK_TENANT ?? "local",
        feedback_application: application,
        feedback_environment: environment,
        feedback_workspace: workspace,
        feedback_permissions: ["feedback.read", "feedback.comment"]
      });
      return sendJson(response, 200, {
        accessToken: brokerResponse.access_token,
        expiresAtEpochSeconds: brokerResponse.expires_at,
        participant: { principalId: session.actorSubject, displayName: session.displayName }
      });
    }
    return serveStatic(request, response);
  } catch (error) {
    console.error("conformance host request failed", error instanceof Error ? error.message : "unknown");
    return sendJson(response, 502, { code: "fixture.broker_unavailable" });
  }
}).listen(port, "0.0.0.0", () => console.log(`feedback conformance consumer listening on ${port}`));

function callBroker(body: unknown): Promise<{ access_token: string; expires_at: number }> {
  const target = new URL(process.env.FEEDBACK_BROKER_URL ?? "https://feedback-token-broker-reference:8443/v1/exchanges");
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname,
      method: "POST",
      cert: readFileSync(requiredEnv("FEEDBACK_BROKER_CLIENT_CERT_FILE")),
      key: readFileSync(requiredEnv("FEEDBACK_BROKER_CLIENT_KEY_FILE")),
      ca: readFileSync(requiredEnv("FEEDBACK_BROKER_CA_FILE")),
      servername: target.hostname,
      headers: { "Content-Type": "application/json" }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (response.statusCode !== 200 || typeof value.access_token !== "string" || typeof value.expires_at !== "number") {
          return reject(new Error(`broker response ${response.statusCode ?? 0}`));
        }
        resolve(value as { access_token: string; expires_at: number });
      });
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

function serveStatic(request: IncomingMessage, response: ServerResponse): void {
  const rawPath = new URL(request.url ?? "/", "http://localhost").pathname;
  const candidate = normalize(join(distDirectory, rawPath));
  const file = candidate.startsWith(distDirectory) && fileExists(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(distDirectory, "index.html");
  response.writeHead(200, {
    "Content-Type": contentType(file),
    "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable"
  });
  createReadStream(file).pipe(response);
}

function fileExists(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  return JSON.parse(await readBody(request, 16_384));
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requiredString(value: Record<string, unknown>, name: string): string {
  const item = value[name];
  if (typeof item !== "string" || item.length < 1 || item.length > 200) throw new Error(`${name} is invalid`);
  return item;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function contentType(path: string): string {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" })[extname(path)]
    ?? "application/octet-stream";
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}
