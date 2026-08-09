# フィードバックシステムの外部依存・人手承認作業

## 1. この文書の目的

本書は、フィードバックシステムの分離・プラガブル化に伴う作業のうち、外部サービス、外部アカウント、
資格情報、公開操作、本番環境または他システムとの調整を必要とするものをまとめる。

ローカルで完結する設計と実装は
[`feedback-system-portability-review.md`](feedback-system-portability-review.md) を正とする。
本書に記載された外部操作は実装タスクの暗黙の許可ではなく、個別に人間の承認を得るための停止点である。

## 2. 共通の安全停止条件

以下は、明示された対象、接続先、資格情報、費用負担者、ロールバック方法について人間が個別承認するまで
実行しない。

- 外部アカウントの作成、サービスへのサインアップ、利用規約への同意、課金プランの選択。
- npm registry、Git repository、container registry、bucket、クラウドリソースの作成。
- `npm login`、`npm publish`、Git の push、PR 作成、image push、deployment。
- `.npmrc`、`.aws`、`.config/gh`、`.docker/config.json`、`.kube`、`.ssh`、実 `.env` など、
  資格情報を含み得るファイルや credential store の探索・読み取り。
- secret manager、CI secret、IdP 管理 API、DNS、証明書管理への読み書き。
- 実在する Email / Teams / Issue tracker / webhook endpoint へのテスト送信。
- 開発共有・staging・production の DB、object storage、OIDC、業務システムへの接続。
- 既存データの移行、dual-write、write 停止、切替、削除、backup / restore。

外部依存が未提供の場合は、別の外部サービスを自動選定・作成して補わない。fixture、mock、ローカルファイル、
`npm pack` などで検証可能な範囲まで進め、外部操作の直前で停止する。

## 3. Package 配布とリポジトリ

### 3.1 ローカルで実施できる範囲

- `@feedback/contracts`、`@feedback/core`、`@feedback/react`、`@feedback/maplibre`、
  `@feedback/admin-react` の package 境界、`exports`、`types`、CSS、semver 方針を実装する。
- `npm pack` した tarball を workspace 外の clean fixture へ install し、build/test する。
- registry 未決定の間は package の `private: true` を維持する。
- 別リポジトリ向けのディレクトリ構成や移行手順は設計できるが、remote repository は作成しない。

### 3.2 人手承認が必要な範囲

- 配布先 registry、所有組織、package scope、公開範囲、料金、保持期間、廃止方法の決定。
- registry/repository の作成と管理者・publisher 権限の付与。
- `publishConfig.registry`、認証方式、CI の publish token、provenance/署名方式の決定。
- `private: true` の解除、pre-release/stable の publish、Git remote への push。

registry が提供されていない場合、正式公開フェーズは未着手として扱う。npmjs.com、GitHub Packages、
その他の hosted registry を実装者が代理で選ばない。

## 4. OIDC と token exchange

### 4.1 ローカルで実施できる範囲

- issuer、audience、subject claim、display-name claim を設定可能な OIDC adapter を実装する。
- repository 内の開発用 Keycloak とテスト鍵だけを使って、JWT/JWKS 検証、未知 issuer の拒否、
  JIT user 登録と membership 既定 deny を検証する。
- token exchange の interface、短寿命 feedback-scoped JWT の claim、mTLS client 認証境界を定義する。
- broker と Feedback Service の適合試験は、ローカル CA、ローカル証明書、mock host session で行う。

### 4.2 人手承認が必要な範囲

- 実 IdP の client、audience、mapper、service account、redirect/origin 設定の追加・変更。
- 実 issuer の JWKS 取得先、claim mapping、鍵 rotation、失効手順の登録。
- CA、client certificate、private key、token signing key の発行・配置・rotation。
- ホスト backend / sidecar への broker deployment と、実セッションを使った token exchange。

業務 API 用 access token を中央 Feedback Service へ転送しない構成を選べるようにする。任意の
`X-User-Id` や `X-Role` を本人性・権限の根拠として直接信用しない。

## 5. Object storage

### 5.1 ローカルで実施できる範囲

- 保存 adapter の `store/open/delete`、private object key、metadata、checksum の契約を実装する。
- local filesystem または資格情報を持たないローカル fixture で、size/content-type、orphan cleanup、
  retention、削除再試行を検証する。

### 5.2 人手承認が必要な範囲

- S3 互換サービス、region、bucket、暗号化方式、KMS、lifecycle、backup、費用上限の決定。
- bucket、IAM role/policy、access key、VPC endpoint、監査設定の作成・変更。
- 実 evidence の upload、copy、checksum 照合、切替、旧 blob の削除。

本番は private な S3 互換 object storage を標準候補とするが、provider と bucket は自動作成しない。
evidence を公開 bucket や恒久署名 URL で配らない。

## 6. Notification、Webhook、外部 Export

### 6.1 ローカルで実施できる範囲

- `feedback.thread.created.v1`、`feedback.message.created.v1`、`feedback.thread.resolved.v1`、
  `feedback.thread.reopened.v1` の domain event と JSON Schema を実装する。
- transactional outbox、delivery ID、timestamp、HMAC/非対称署名、retry、重複配送、poison delivery を
  ローカル HTTP fixture で検証する。
- 本文と evidence URL は既定 payload に含めず、外部通知を正本にしない。

### 6.2 人手承認が必要な範囲

- Email、Teams、Issue tracker、任意 webhook の接続先、送信主体、宛先、権限、費用の決定。
- endpoint secret、HMAC secret、OAuth client、API token の発行・登録・rotation。
- 実在する宛先への疎通確認、テスト配送、再送、dead-letter の操作。
- 非同期 Export の外部保存先と期限付き download URL の配信。

## 7. Deployment と運用基盤

### 7.1 ローカルで実施できる範囲

- 1 image 内で HTTP API、notification worker、provisioning の command を分ける。
- ローカル compose と fixture で live/readiness、DB、storage、contract version を検証する。
- ECS task definition または Helm values のテンプレートを、secret 値を含めずに作成・静的検査する。

### 7.2 人手承認が必要な範囲

- container registry への image push。
- ECS / Kubernetes / load balancer / DNS / TLS / WAF / secret manager / monitoring の作成・変更。
- staging/production deployment、traffic 切替、rollback、backup/restore 訓練。
- application manifest を production へ登録する CI と application admin token の作成・登録。

## 8. データ移行と consumer 2

### 8.1 ローカルで実施できる範囲

- 現行 DTO/DB 列から新契約への mapping table、copy/dual-read/redirect の設計を作る。
- 匿名化した fixture で thread ID、display number、message history、evidence retention、permalink の
  移行・照合試験を行う。
- Web GIS と異なる認証・router・画面構成を持つ repository 内 conformance fixture を consumer 2 として使う。

### 8.2 人手承認が必要な範囲

- 実データの抽出・転送・backfill・checksum 照合。
- 旧 API の read-only 化、dual-read/dual-write、write 停止、traffic 切替、旧データ削除。
- 別チームまたは別業務システムを consumer 2 として接続するためのアカウント・IdP・ネットワーク調整。

DB migration はコピー方式を基本とし、旧 DB を即時削除しない。evidence blob は移行完了と checksum 照合まで
旧参照を保持する。dual-write を採用する場合は照合レポートが 0 差分になってから切り替える。

## 9. 個別承認時の確認事項

外部操作を依頼するときは、少なくとも次を明示する。

1. 実行する操作と、作成・変更される外部リソース。
2. 対象 organization/account、environment、region、repository、registry、DB/bucket 名。
3. 使用してよい資格情報と、その最小権限・有効期限。
4. 外部へ送信されるデータと、機微情報を含まないことの確認。
5. 費用上限、公開範囲、保持期間。
6. 検証方法、ロールバック方法、削除時の承認者。

「計画全体を実装する」「正式公開まで進める」といった包括的な指示は、上記の個別承認を代替しない。
