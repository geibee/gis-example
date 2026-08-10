# Changelog

## 2026-08-10

- 管理画面からレビュー状態を一度で作成し、対象画面と観点を編集できるよう、セッション作成へ任意の `status`、PATCHへ任意の `scopes` / `perspectives` を後方互換で追加。
- セッション／スレッド状態を文字列型として明示し、Go HTTPサーバーで`status`クエリを束縛できない生成不具合を修正。

## 1.0.0-alpha.2

- 日次フル＋差分の証跡バックアップ方針、実行履歴、認可付きZIPダウンロードを追加。
- Connector Protocol v1と通知コネクタcatalog／workspace設定APIを追加。
- 従来の単一Webhook設定をdeprecatedとし、互換APIとして維持。

## 1.0.0-alpha.1

- Feedback Service v1 の専用 OpenAPI と TypeScript 型を追加。
- application manifest、location、target、webhook event の JSON Schema を追加。
