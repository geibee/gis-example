// トースト通知のストア。React ツリー外 (QueryClient のグローバル onError 等) からも
// 発火できるよう、購読モデルの軽量ストアとして実装する。表示は src/ui/Toaster.tsx が担う。
//
// 使い方:
//   notifySuccess("保存しました");        // 成功 (緑・4 秒で自動消滅)
//   notifyError("保存に失敗しました");     // エラー (赤・8 秒で自動消滅)
//   notifyInfo("検索結果はありません");    // 情報 (琥珀・6 秒で自動消滅)
export type ToastKind = "success" | "error" | "info";

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
};

type ToastListener = (toasts: Toast[]) => void;

// エラーは読む時間を長めに取る。自動消滅させたくない場合は duration の外出しを検討する。
const autoDismissMs: Record<ToastKind, number> = {
  success: 4000,
  info: 6000,
  error: 8000
};

// 同時表示の上限。超えた分は古いものから閉じる (画面を通知で覆い尽くさない)
const maxToasts = 5;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<ToastListener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener(toasts);
}

export function subscribeToasts(listener: ToastListener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

export function notify(message: string, kind: ToastKind = "info") {
  const toast: Toast = { id: nextId++, kind, message };
  toasts = [...toasts, toast].slice(-maxToasts);
  timers.set(
    toast.id,
    setTimeout(() => dismissToast(toast.id), autoDismissMs[kind])
  );
  emit();
}

export function notifySuccess(message: string) {
  notify(message, "success");
}

export function notifyError(message: string) {
  notify(message, "error");
}

export function notifyInfo(message: string) {
  notify(message, "info");
}

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

// テストのクリーンアップ用 (タイマーも含めて全消し)
export function clearToasts() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (!toasts.length) return;
  toasts = [];
  emit();
}
