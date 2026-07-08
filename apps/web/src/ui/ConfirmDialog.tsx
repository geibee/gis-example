import { useEffect, useRef, useState, type KeyboardEvent } from "react";

// window.confirm の置き換え。Promise を返すので既存の
// `if (!window.confirm("...")) return;` は `if (!(await confirmDialog({ message: "..." }))) return;`
// に書き換えるだけで移行できる。表示ホスト (ConfirmDialogHost) は App に 1 つだけ置く。
export type ConfirmOptions = {
  /** ダイアログ見出し (省略時は「確認」) */
  title?: string;
  message: string;
  /** 実行ボタンのラベル (省略時は「OK」) */
  confirmLabel?: string;
  cancelLabel?: string;
  /** 削除など破壊的操作は true (実行ボタンが赤くなる) */
  danger?: boolean;
};

type ConfirmRequest = ConfirmOptions & { resolve: (confirmed: boolean) => void };

let listener: ((request: ConfirmRequest | null) => void) | null = null;

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!listener) {
      // ホスト未マウント (テスト等)。ブロックしないよう既定でキャンセル扱いにする
      resolve(false);
      return;
    }
    listener({ ...options, resolve });
  });
}

export function ConfirmDialogHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  useEffect(() => {
    listener = setRequest;
    return () => {
      if (listener === setRequest) listener = null;
    };
  }, []);
  if (!request) return null;

  const close = (confirmed: boolean) => {
    request.resolve(confirmed);
    setRequest(null);
  };
  return <ConfirmDialogPanel request={request} onClose={close} />;
}

function ConfirmDialogPanel({
  request,
  onClose
}: {
  request: ConfirmRequest;
  onClose: (confirmed: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // 開いたらキャンセルボタンへフォーカス (誤操作で破壊的操作が実行されない安全側の既定)。
  // 閉じたら元のフォーカス位置へ戻す。
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, []);

  // フォーカストラップ: Tab をダイアログ内のフォーカス可能要素で循環させる
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>("button");
    if (!focusables?.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="confirm-backdrop" onMouseDown={() => onClose(false)}>
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id="confirm-dialog-title">{request.title ?? "確認"}</h2>
        <p id="confirm-dialog-message">{request.message}</p>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} className="subtle-button" type="button" onClick={() => onClose(false)}>
            {request.cancelLabel ?? "キャンセル"}
          </button>
          <button
            className={request.danger ? "danger-button" : "command-button"}
            type="button"
            onClick={() => onClose(true)}
          >
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
