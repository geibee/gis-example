# Feedback API v1 移行マッピング

この文書は、現行 Web GIS のレビュー契約を独立 Feedback Service v1 へコピー移行する際の
field・resource 対応を固定する。v1 の SSoT は
[`contracts/feedback/openapi.yaml`](../contracts/feedback/openapi.yaml) と同ディレクトリの JSON Schema である。

## スコープと主体

| 現行 Web GIS | Feedback v1 | 移行規則 |
|---|---|---|
| `app.projects.id` | `workspaces.id` | Feedback Service が新しい内部 UUID を採番する |
| `projectId` | `externalWorkspaceKey` | UUID 文字列表現を外部 key として保存する |
| 固定の Web GIS | `application` | `applicationKey=web-gis` として事前登録する |
| 配備先 URL / OIDC 設定 | `environment` | dev/staging/production を別 resource として登録する |
| `app.users.id` / JWT `sub` | `users.id` / principal | issuer と subject の組で JIT 解決し、membership は自動付与しない |
| `viewer` | `feedback.read`, `feedback.comment` | 移行時だけの role adapter で変換する |
| `editor` | viewer 権限 + `feedback.manage` | 業務 role を v1 API の永続語彙へ持ち込まない |
| system admin | `feedback.admin` | tenant/application 管理者 membership を明示作成する |

ホスト DB の table へ外部キーは張らない。移行後の対応表は Feedback Service の
`workspace_external_keys` が所有する。

## Session と location

| 現行 field | v1 field | 規則 |
|---|---|---|
| `ReviewSession.id` | `FeedbackSessionV1.id` | UUID を維持する |
| `projectId` | `applicationKey` / `environmentKey` / `externalWorkspaceKey` | consumer adapter が分解する |
| `title`, `description`, `startAt`, `endAt` | 同名 | 値を維持する |
| `draft/open/closed` | 同名 status | 値を維持する |
| scope 外の暗黙許可 | `outOfScopePosting=warn` | 現行挙動を警告付き許可として明文化する |
| `ReviewScope.pageId` | `location.pageKey` | manifest 登録済み key へ変換する |
| `ReviewScope.route` | `location.routeTemplate` | `{id}` template を維持する |
| `FeedbackThread.pageRoute` | `location.pathParameters` / `queryParameters` | 生 URL は移行しない。manifest policy で再解析する |
| evidence の `route` | location の補助入力 | `pageRoute` がない旧データだけに使用し、生 URL は移行後に破棄する |

path/query parameter は manifest の `store/hash/discard` に従う。既定は `discard` であり、
token、メールアドレス、自由検索条件をそのまま移行しない。

## Thread、target、message

| 現行 field | v1 field | 規則 |
|---|---|---|
| `FeedbackThread.id` | `FeedbackThreadV1.id` | UUID を維持する |
| `reviewSessionId` | `sessionId` | UUID を維持する |
| `displayNumber` | `displayNumber` | セッション内番号を維持する |
| `perspectiveCode` | `perspectiveCode` | manifest/session 定義と照合する |
| `OPEN/RESOLVED` | `open/resolved` | 小文字へ正規化する |
| `createdBy`, `createdByName`, `reporterName` | `reporter.principalId/displayName/participantName` | 認証主体と自己申告名を分離したまま移す |
| `targetType=UI_ELEMENT` | `kind=ui-element` | `feedbackTargetId` → `elementKey` |
| `targetType=SCREEN_POSITION` | `kind=screen-position` | 相対座標を維持し 0..1 を再検証する |
| `targetType=MAP_FEATURE` | `kind=map-feature` | source → manifest の安定 `sourceKey`、featureId → `featureKey` |
| `targetType=MAP_POSITION` | `kind=map-position` | WGS84 範囲を再検証する |
| `FeedbackMessage.author*`, `participantName` | `author.*` | 認証主体と自己申告名を分離する |
| message history | `FeedbackMessageVersionV1` | 全版と編集者を順序どおりコピーする |

不正座標、空 key、manifest に対応しない location は移行を止め、隔離レポートへ出す。暗黙補正はしない。

## Evidence、通知、監査

| 現行 | v1 | 規則 |
|---|---|---|
| local/S3 object key | private object key | checksum を照合するまで旧 blob を保持する |
| retention 未設定 | `evidenceRetentionDays=null` | 暗黙の削除期限を追加しない |
| Email/Teams/Issue payload | domain webhook event | 本文・証跡は既定で含めない |
| notification outbox | notification outbox/delivery | event ID と delivery ID を新規採番し重複配送を許容する |
| `app.audit_logs` | feedback 専用 audit log | mutate、deny、evidence read、export を追記専用で移す |

## API endpoint 対応

| 現行 | v1 |
|---|---|
| `GET /api/me` | `GET /feedback/v1/me` |
| `GET/POST /api/review-sessions` | `GET/POST /feedback/v1/sessions` |
| `GET/PATCH /api/review-sessions/{id}` | `GET/PATCH /feedback/v1/sessions/{sessionId}` |
| `GET/POST /api/review-sessions/{id}/threads` | `GET/POST /feedback/v1/sessions/{sessionId}/threads` |
| `GET /api/threads/{id}` | `GET /feedback/v1/threads/{threadId}` |
| `POST /api/threads/{id}/messages` | `POST /feedback/v1/threads/{threadId}/messages` |
| `PATCH /api/messages/{id}` | `PATCH /feedback/v1/messages/{messageId}` |
| `GET /api/messages/{id}/history` | `GET /feedback/v1/messages/{messageId}/versions` |
| `PATCH /api/threads/{id}/status` | `PATCH /feedback/v1/threads/{threadId}/status` |
| `GET /api/threads/{id}/evidence` | `GET /feedback/v1/threads/{threadId}/evidence` |
| browser CSV | `POST /feedback/v1/exports` |

旧 API は Phase 4 の切替まで consumer 1 の互換層として維持する。dual-write を採用する場合は、
session/thread/message/evidence の ID・件数・checksum 照合が 0 差分になった後だけ read path を切り替える。
