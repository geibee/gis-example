import type { RedmineFeedbackPluginController } from "@geibee/feedback-redmine-plugin/loader";

type FeedbackMap = Parameters<RedmineFeedbackPluginController["registerMapLibreMap"]>[0];
type RegisteredMap = {
  references: number;
  disconnect: (() => void) | null;
};

const registeredMaps = new Map<FeedbackMap, RegisteredMap>();
let activeController: RedmineFeedbackPluginController | null = null;

/**
 * 遅延生成されるMapLibre mapとruntime config読込後のFeedback controllerを疎結合に接続する。
 * どちらが先に生成されても、双方が揃った時点で地図キャプチャを登録する。
 */
export function connectFeedbackController(controller: RedmineFeedbackPluginController): () => void {
  if (activeController && activeController !== controller) {
    throw new Error("Feedback controllerが二重に接続されています");
  }
  activeController = controller;
  registeredMaps.forEach((entry, map) => {
    entry.disconnect ??= controller.registerMapLibreMap(map);
  });

  let connected = true;
  return () => {
    if (!connected || activeController !== controller) return;
    connected = false;
    registeredMaps.forEach((entry) => {
      entry.disconnect?.();
      entry.disconnect = null;
    });
    activeController = null;
  };
}

export function registerFeedbackMap(map: FeedbackMap): () => void {
  const existing = registeredMaps.get(map);
  if (existing) {
    existing.references += 1;
  } else {
    registeredMaps.set(map, {
      references: 1,
      disconnect: activeController?.registerMapLibreMap(map) ?? null
    });
  }

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const entry = registeredMaps.get(map);
    if (!entry) return;
    entry.references -= 1;
    if (entry.references > 0) return;
    entry.disconnect?.();
    registeredMaps.delete(map);
  };
}
