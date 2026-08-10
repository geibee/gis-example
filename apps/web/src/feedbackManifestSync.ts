import {
  FeedbackTransportError,
  type FeedbackApplicationManifestV1,
  type FeedbackTransport
} from "@feedback/core";

export type FeedbackManifestSyncResult = "unchanged" | "created" | "updated";

/**
 * ホストアプリ自身が持つ画面定義をFeedback Serviceへ冪等に同期する。
 * manifestVersionが同じなのに内容が異なる場合は、履歴を上書きせず版の更新を要求する。
 */
export async function syncFeedbackApplicationManifest(
  transport: FeedbackTransport,
  manifest: FeedbackApplicationManifestV1
): Promise<FeedbackManifestSyncResult> {
  const path = `/applications/${encodeURIComponent(manifest.applicationKey)}/manifest`;
  try {
    const current = await transport.request<FeedbackApplicationManifestV1>(path);
    if (equalJSON(current.value, manifest)) return "unchanged";
    if (current.value.manifestVersion === manifest.manifestVersion) {
      throw new Error(
        `画面定義の内容が変更されています。manifestVersion ${manifest.manifestVersion} を更新してください`
      );
    }
    await putManifest(transport, path, manifest, current.etag ?? undefined);
    return "updated";
  } catch (caught) {
    if (!(caught instanceof FeedbackTransportError) || caught.status !== 404) throw caught;
    await putManifest(transport, path, manifest);
    return "created";
  }
}

async function putManifest(
  transport: FeedbackTransport,
  path: string,
  manifest: FeedbackApplicationManifestV1,
  ifMatch?: string
): Promise<void> {
  try {
    await transport.request(path, { method: "PUT", body: manifest, ...(ifMatch ? { ifMatch } : {}) });
  } catch (caught) {
    // StrictModeや複数tabから初回同期が重なった場合、先行要求の登録結果を再確認する。
    if (!(caught instanceof FeedbackTransportError) || (caught.status !== 409 && caught.status !== 412)) throw caught;
    const current = await transport.request<FeedbackApplicationManifestV1>(path);
    if (!equalJSON(current.value, manifest)) throw caught;
  }
}

function equalJSON(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}
