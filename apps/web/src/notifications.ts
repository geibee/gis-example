// 通知 (トースト) を React ツリー外 (QueryClient のグローバル onError 等) から
// 発火するための最小のブリッジ。AppShellProvider がマウント時に購読する。
type NoticeListener = (message: string) => void;

let listener: NoticeListener | null = null;

export function subscribeNotices(next: NoticeListener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

export function notify(message: string) {
  listener?.(message);
}
