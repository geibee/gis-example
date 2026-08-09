import type { FeedbackParticipant } from "@feedback/core";

export type FeedbackExchangeScope = {
  applicationKey: string;
  environmentKey: string;
  externalWorkspaceKey: string;
};

export type FeedbackExchangeResult = {
  accessToken: string;
  expiresAtEpochSeconds: number;
  participant: FeedbackParticipant;
};

export type FeedbackTokenBroker = (scope: FeedbackExchangeScope) => Promise<FeedbackExchangeResult>;

/**
 * consumer のHttpOnly sessionを短寿命feedback tokenへ交換する境界。
 * 業務API tokenやroleは入力にせず、scopeが変われば必ず再交換する。
 */
export class FeedbackTokenExchangeAdapter {
  private readonly cache = new Map<string, FeedbackExchangeResult>();

  constructor(
    private readonly broker: FeedbackTokenBroker,
    private readonly nowEpochSeconds: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  async getAccessToken(scope: FeedbackExchangeScope, forceRefresh = false): Promise<string> {
    const key = scopeKey(scope);
    const cached = this.cache.get(key);
    if (!forceRefresh && cached && cached.expiresAtEpochSeconds > this.nowEpochSeconds() + 30) {
      return cached.accessToken;
    }
    const exchanged = await this.broker(scope);
    if (!exchanged.accessToken || exchanged.expiresAtEpochSeconds <= this.nowEpochSeconds()) {
      throw new Error("token exchange が有効な短寿命tokenを返しませんでした");
    }
    this.cache.set(key, exchanged);
    return exchanged.accessToken;
  }

  getIdentity(scope: FeedbackExchangeScope): FeedbackParticipant | null {
    return this.cache.get(scopeKey(scope))?.participant ?? null;
  }

  clear(): void {
    this.cache.clear();
  }
}

function scopeKey(scope: FeedbackExchangeScope): string {
  return `${scope.applicationKey}\u0000${scope.environmentKey}\u0000${scope.externalWorkspaceKey}`;
}

/** fixture host backend のmock exchange endpoint。secretをbrowser bundleへ置かない。 */
export async function browserTokenBroker(scope: FeedbackExchangeScope): Promise<FeedbackExchangeResult> {
  let response = await requestFixtureToken(scope);
  if (response.status === 401) {
    const session = await fetch("/fixture-auth/session", { method: "POST", credentials: "include" });
    if (!session.ok) throw new Error(`fixture sessionの開始に失敗しました (${session.status})`);
    response = await requestFixtureToken(scope);
  }
  if (!response.ok) throw new Error(`token exchange に失敗しました (${response.status})`);
  return await response.json() as FeedbackExchangeResult;
}

function requestFixtureToken(scope: FeedbackExchangeScope): Promise<Response> {
  return fetch("/fixture-auth/feedback-token", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scope)
  });
}
