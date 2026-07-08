import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { dismissToast, subscribeToasts, type Toast, type ToastKind } from "../notifications";

// トーストの表示ホスト。App のルートレイアウトに 1 つだけ置く。
// 発火は src/notifications.ts の notifySuccess / notifyError / notifyInfo で行う。
const kindIcon: Record<ToastKind, typeof Info> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info
};

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);
  if (!toasts.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const Icon = kindIcon[toast.kind];
  return (
    // エラーは即時に読み上げる (role=alert)。成功・情報は操作の読み上げを遮らない (role=status)
    <div className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
      <Icon size={16} aria-hidden="true" />
      <span className="toast-message">{toast.message}</span>
      <button type="button" aria-label="通知を閉じる" onClick={() => dismissToast(toast.id)}>
        <X size={14} />
      </button>
    </div>
  );
}
