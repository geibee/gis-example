import { createHmac, timingSafeEqual } from "node:crypto";

export type FixtureSession = {
  actorIssuer: string;
  actorSubject: string;
  displayName: string;
  email?: string;
  expiresAt: number;
};

export function signFixtureSession(session: FixtureSession, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyFixtureSession(value: string | undefined, secret: string, now = Math.floor(Date.now() / 1000)): FixtureSession | null {
  if (!value) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as FixtureSession;
    if (!session.actorIssuer || !session.actorSubject || !session.displayName || session.expiresAt <= now) return null;
    return session;
  } catch {
    return null;
  }
}
