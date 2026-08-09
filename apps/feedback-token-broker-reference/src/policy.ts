export const feedbackPermissions = [
  "feedback.read",
  "feedback.comment",
  "feedback.manage",
  "feedback.admin"
] as const;

export type FeedbackPermission = typeof feedbackPermissions[number];

export type TokenExchangeRequest = {
  actor_issuer: string;
  actor_sub: string;
  actor_name?: string;
  actor_email?: string;
  feedback_tenant: string;
  feedback_application: string;
  feedback_environment: string;
  feedback_workspace: string;
  feedback_permissions: FeedbackPermission[];
  requested_lifetime_seconds?: number;
};

export type ClientPolicy = {
  id: string;
  fingerprint256?: string;
  subjectCn?: string;
  actorIssuers: string[];
  tenants: string[];
  applications: string[];
  environments: string[];
  workspaces: string[];
  permissions: FeedbackPermission[];
};

export type MtlsIdentity = { fingerprint256?: string; subjectCn?: string };

export class BrokerPolicyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function authorizeExchange(
  identity: MtlsIdentity,
  raw: unknown,
  policies: ClientPolicy[]
): { request: TokenExchangeRequest; clientId: string } {
  const policy = policies.find((candidate) =>
    (candidate.fingerprint256 !== undefined && candidate.fingerprint256 === identity.fingerprint256) ||
    (candidate.subjectCn !== undefined && candidate.subjectCn === identity.subjectCn)
  );
  if (!policy) throw new BrokerPolicyError(403, "client.unknown", "mTLS clientは登録されていません");
  const request = parseRequest(raw);
  assertAllowed(policy.actorIssuers, request.actor_issuer, "actor_issuer");
  assertAllowed(policy.tenants, request.feedback_tenant, "feedback_tenant");
  assertAllowed(policy.applications, request.feedback_application, "feedback_application");
  assertAllowed(policy.environments, request.feedback_environment, "feedback_environment");
  assertAllowed(policy.workspaces, request.feedback_workspace, "feedback_workspace");
  if (request.feedback_permissions.some((permission) => !policy.permissions.includes(permission))) {
    throw new BrokerPolicyError(403, "scope.permission_denied", "要求permissionがmTLS client上限を越えています");
  }
  return { request, clientId: policy.id };
}

function parseRequest(raw: unknown): TokenExchangeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BrokerPolicyError(400, "request.invalid", "JSON objectが必要です");
  }
  const value = raw as Record<string, unknown>;
  const known = new Set([
    "actor_issuer", "actor_sub", "actor_name", "actor_email", "feedback_tenant",
    "feedback_application", "feedback_environment", "feedback_workspace",
    "feedback_permissions", "requested_lifetime_seconds"
  ]);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new BrokerPolicyError(400, "request.unknown_field", "未定義フィールドがあります");
  }
  const permissions = value.feedback_permissions;
  if (!Array.isArray(permissions) || permissions.length === 0 ||
      permissions.some((item) => typeof item !== "string" || !feedbackPermissions.includes(item as FeedbackPermission)) ||
      new Set(permissions).size !== permissions.length) {
    throw new BrokerPolicyError(400, "request.invalid_permissions", "feedback_permissionsが不正です");
  }
  const requestedLifetime = value.requested_lifetime_seconds;
  if (requestedLifetime !== undefined &&
      (!Number.isInteger(requestedLifetime) || (requestedLifetime as number) < 30 || (requestedLifetime as number) > 300)) {
    throw new BrokerPolicyError(400, "request.invalid_lifetime", "lifetimeは30..300秒です");
  }
  const actorName = optionalString(value, "actor_name", 200);
  const actorEmail = optionalString(value, "actor_email", 320);
  return {
    actor_issuer: requiredString(value, "actor_issuer", 1000),
    actor_sub: requiredString(value, "actor_sub", 200),
    ...(actorName === undefined ? {} : { actor_name: actorName }),
    ...(actorEmail === undefined ? {} : { actor_email: actorEmail }),
    feedback_tenant: requiredString(value, "feedback_tenant", 100),
    feedback_application: requiredString(value, "feedback_application", 63),
    feedback_environment: requiredString(value, "feedback_environment", 100),
    feedback_workspace: requiredString(value, "feedback_workspace", 200),
    feedback_permissions: permissions as FeedbackPermission[],
    ...(requestedLifetime === undefined ? {} : { requested_lifetime_seconds: requestedLifetime as number })
  };
}

function requiredString(value: Record<string, unknown>, name: string, maxLength: number): string {
  const item = value[name];
  if (typeof item !== "string" || item.length === 0 || item.length > maxLength) {
    throw new BrokerPolicyError(400, "request.invalid", `${name}が不正です`);
  }
  return item;
}

function optionalString(value: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  const item = value[name];
  if (item === undefined) return undefined;
  if (typeof item !== "string" || item.length === 0 || item.length > maxLength) {
    throw new BrokerPolicyError(400, "request.invalid", `${name}が不正です`);
  }
  return item;
}

function assertAllowed(values: string[], requested: string, field: string): void {
  if (!values.includes(requested)) {
    throw new BrokerPolicyError(403, "scope.denied", `${field}がmTLS client上限を越えています`);
  }
}
