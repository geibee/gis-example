# プロトタイプレビュー通知・外部連携

プロトタイプレビュー Phase 7 の Email / Microsoft Teams / Issue 生成は、外部サービスとの
**一方向連携**として実装する。外部側の更新を GIS へ同期せず、レビュー本文・状態・監査の正本は
PostgreSQL のままとする。

## 配信の流れ

```text
Thread作成 / 返信 / Resolve / Reopen
              │ 同一DB transaction
              ▼
review_notification_outbox + deliveries
              │ 非同期 claim (FOR UPDATE SKIP LOCKED)
              ▼
       Email (SES) / Teams / Issue Webhook
```

- プロジェクトの editor が管理画面でチャネルを有効化するまで、outbox は作られない
- Email はイベント実行者を除く、有効なプロジェクトメンバーへ 1 宛先 1 delivery で送る
- Teams は Power Automate / Teams の「When a Teams webhook request is received」へ
  Adaptive Card を POST する
- Issue は `THREAD_CREATED` のときだけ 1 件生成する。返信・Resolve・Reopen で Issue を増やさない
- Issue Webhook には `Idempotency-Key` と本文の `idempotencyKey` として outbox ID を渡す。
  受信側もこの値を一意キーとして扱う
- ワーカーは指数バックオフで既定 5 回まで再試行する。上限到達後は管理画面から再試行できる
- ワーカー停止中も outbox は DB に残るため、レビュー操作自体は外部サービス障害の影響を受けない

## 外部へ送る情報

送るものは、プロジェクト名、レビューセッション名、観点、実行者表示名、コメント本文、
プロジェクト ID、スレッド ID、内部レビュー画面へのリンクに限定する。

次の情報は送らない。

- 証跡スクリーンショットと Blob の保存先
- `target_metadata` に含まれる画面座標・地物 ID・地図座標
- OIDC token、Webhook URL、Webhook token

コメント本文自体に個人情報・業務情報が含まれる可能性はあるため、プロジェクトごとの有効化は
外部サービスへの情報提供を許可した場合だけ行う。閉域運用では Teams / Issue を無効のままにし、
組織内 SES だけを使う構成も取れる。

## 実行方式

dev 既定は API 内の `in-process`。本番で API を複数タスクに水平分割する場合は
`REVIEW_NOTIFICATION_RUNNER_MODE=external` とし、同じ API イメージを
`bin/review-notification-worker` で 1 個以上起動する。複数ワーカーでも `SKIP LOCKED` により
同じ delivery を同時 claim しない。

配信保証は at-least-once。DB commit 後、外部サービスが受理してから成功状態を DB へ書くまでに
ワーカーが停止した場合は再送され得る。Issue Webhook は上記 idempotency key で重複生成を防ぐ。
Teams / SES は受信成功後の通信断で重複表示・重複メールになり得るため、通知は正本ではなく
案内として扱う。

## 接続先とシークレット

接続先は DB や API request に保存せず、すべて環境変数から構築する。

- `REVIEW_EMAIL_FROM` を設定すると Amazon SES v2 を有効化する。認証は ECS タスクロール
- `REVIEW_TEAMS_WEBHOOK_URL` は Teams / Power Automate が発行した URL
- `REVIEW_ISSUE_WEBHOOK_URL` は `review.issue.create` JSON を受けて GitHub / GitLab / Jira 等へ
  Issue を作る組織内アダプターの URL
- `REVIEW_ISSUE_WEBHOOK_TOKEN` は任意の Bearer token

Webhook URL と token は Secrets Manager から注入し、API は接続先を返さずチャネルの
`available` だけを返す。ログにも URL・token・Email 宛先を出さない。

Email はユーザー操作を契機とする transactional mail として扱う。`REVIEW_EMAIL_FROM` には
SES で検証済みの組織ドメインを使い、SPF / DKIM と DMARC を設定する。SES の配信・bounce・
complaint・suppression 指標を監視し、恒久 bounce の宛先は `app.users.email` の IdP 側データを
修正する。開発確認でも存在しないダミー宛先へ実送信しない。
