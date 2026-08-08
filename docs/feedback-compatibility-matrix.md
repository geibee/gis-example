# Feedback v1 互換性マトリクス

この文書はローカルで検証済みの互換範囲を示す。package は registry 未承認のため `private: true` であり、
ここにある version は公開・サポート開始を意味しない。

| API | contracts/core/react/maplibre/admin-react | React | 検証 consumer |
|---|---|---|---|
| Feedback API `1.0` (`/feedback/v1`) | `1.0.0-alpha.1` | 18.3 / 19.1 | Web GIS consumer 1、在庫承認 consumer 2 |

- SDK は `/capabilities` の API major、manifest schema、target schema を起動時に照合する。
- API は同じ major 内で field を追加するとき、既存 client が未知 field を無視できる範囲に限定する。
- breaking change は新しい major API path と package major で提供する。適用済み DB migration は変更しない。
- alpha 期間中の互換期間は `legacy` → `feedback-v1-dual-read` → `feedback-v1` の順とする。
- stable 化時に「現行 minor と1つ前の SDK minor」を最低サポート範囲として再確認し、終了日を明記する。

ローカルゲートは tarball を clean React 18/19 fixture へ install し、consumer 2 を Web GIS 固有 import なしで
typecheck/test/build する。正式な registry、support SLA、公開日、廃止日は人手承認後に追記する。
