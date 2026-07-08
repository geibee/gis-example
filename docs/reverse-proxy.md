# リバースプロキシ (CloudFront/ALB) 配下での運用

TLS 終端・証明書管理 (ACM)・レートリミット (AWS WAF) はクラウド側の責務であり、
本リポジトリのアプリは **HTTP でプロキシの背後に置かれる** 前提で動く。
このドキュメントは、その前提でアプリ側が担う設定 (プロキシヘッダの信頼・URL の注入・
セキュリティヘッダ) と、infra 側へのインプット (WAF レートリミット設計) をまとめる。

## 前提の構成

```
ブラウザ ──HTTPS──> CloudFront ──> ALB ──HTTP──> web (nginx) ──HTTP──> api (Ktor)
                     │                            └ 静的配信 + /api リバースプロキシ
                     └ TLS 終端 / HSTS / WAF
```

dev (infra/docker-compose.yml) はプロキシなしの直接アクセスのため、
以下の本番向け設定はすべて **既定で無効 / localhost 既定** になっている。

## X-Forwarded-* の信頼 (api: TRUSTED_PROXY_COUNT)

api は `TRUSTED_PROXY_COUNT` (既定 `0`) が 1 以上のときだけ Ktor の `XForwardedHeaders`
プラグインを有効化し、`X-Forwarded-Proto` / `X-Forwarded-For` から scheme (https 判定) と
クライアント IP を復元する (実装: `apps/api/src/main/kotlin/gis/example/ForwardedHeaders.kt`)。

**信頼境界 (重要):**

- `X-Forwarded-*` はクライアントが自由に詐称できる。**API を直接公開する構成では必ず
  `0` (無効) のままにする** こと。dev compose は直接アクセスのため `0` にしている
- 値は「自分の手前にいる、ヘッダへ追記する信頼できるプロキシの段数」。
  各プロキシは「自分から見た接続元」を `X-Forwarded-For` の末尾に追記するため、
  信頼段数 N のとき末尾から N 番目が実クライアント IP になる (それより先頭は詐称可能)

| 構成 | TRUSTED_PROXY_COUNT |
|---|---|
| 直接公開 (dev compose) | `0` (既定) |
| ALB → api | `1` |
| CloudFront → ALB → api | `2` |
| CloudFront → ALB → web nginx → api (/api 経由) | `3` |

web の nginx は `/api` プロキシ時に `X-Forwarded-For` へ自分の接続元を追記し、
上流から受けた `X-Forwarded-Proto` をそのまま引き継ぐ (自分では作らない)。
nginx を経由する経路としない経路が混在する構成は段数が一意に決まらないため作らないこと。

## URL・オリジンの環境変数 (localhost 既定はすべて dev 専用)

| 変数 | 対象 | 用途 | dev 既定 | 本番での値 (例) |
|---|---|---|---|---|
| `API_PUBLIC_URL` | api | TileJSON の絶対 URL 生成 | `http://localhost:8080` | `https://gis.example.com` |
| `WEB_ORIGIN` | api | CORS 許可オリジン | `http://localhost:5173` | `https://gis.example.com` |
| `OIDC_ISSUER` | api | JWT の iss 検証 (必須・既定なし) | — | `https://auth.example.com/realms/gis` |
| `OIDC_JWKS_URL` | api | JWKS 取得先 (未設定時は issuer から導出) | — | (通常は不要) |
| `TRUSTED_PROXY_COUNT` | api | X-Forwarded-* の信頼段数 | `0` | 上表参照 |
| `VITE_OIDC_AUTHORITY` | web (build-arg) | SPA の OIDC authority (bundle へ焼き込み) | `http://localhost:8081/realms/gis` | `https://auth.example.com/realms/gis` |
| `VITE_OIDC_CLIENT_ID` | web (build-arg) | SPA の OIDC client_id | `gis-web` | 環境の client_id |
| `CSP_CONNECT_SRC_EXTRA` | web (build-arg) | CSP connect-src に加える外部接続先 | `http://localhost:8081` | `https://auth.example.com` |

- web 側は Vite の `import.meta.env` によりビルド時に確定する。**本番イメージは
  `docker build --build-arg VITE_OIDC_AUTHORITY=... --build-arg CSP_CONNECT_SRC_EXTRA=...`
  で環境ごとにビルドする** (CSP_CONNECT_SRC_EXTRA は VITE_OIDC_AUTHORITY の origin と揃える)
- `infra/keycloak/realm-gis.json` は **dev 専用の IdP 定義** (redirectUris / webOrigins が
  `http://localhost:5173` 固定)。本番 IdP では、クライアント `gis-web` の
  redirectUris / webOrigins / post.logout.redirect.uris に本番の HTTPS オリジンを登録する
  (SPA 側の redirect_uri は `window.location.origin` 由来のためコード変更は不要)

## セキュリティヘッダの分担

| ヘッダ | 付与する場所 | 理由 |
|---|---|---|
| `Strict-Transport-Security` (HSTS) | CloudFront (Response Headers Policy) | TLS を終端する側が管理する。nginx では付けない (二重管理しない) |
| `Content-Security-Policy` ほか | web nginx (`apps/web/nginx.conf`) | CSP はアプリの構成 (MapLibre の worker/inline style、タイル・IdP の接続先) に依存するためリポジトリ側で定義する |

nginx が付けるヘッダは「CloudFront が付けない前提の既定」であり、CloudFront 側で
同名ヘッダを上書き付与する場合は二重にならないよう片方に寄せること。
CSP の各ディレクティブの根拠は `apps/web/nginx.conf` のコメントを参照。

## WAF レートリミット設計 (infra 側へのインプット)

nginx の `limit_req` は使わず AWS WAF の rate-based rule で行う。優先度順:

| 対象 | パス | 推奨 | 根拠 |
|---|---|---|---|
| 認証エンドポイント | IdP 側 `/realms/*/protocol/openid-connect/token` ほか | 厳しめ (IP 単位) | クレデンシャルスタッフィング対策。API 自体はログインを持たない (Bearer 検証のみ) |
| ファイル取込 | `POST /api/import-jobs`, `POST /api/zone-layers/from-import` | 低頻度に制限 | 最大 200MB のアップロードとジョブ生成を伴う (`UPLOAD_MAX_BYTES`) |
| 分析ジョブ生成 | `POST /api/analysis-jobs` | 低頻度に制限 | PostGIS の空間演算ジョブを生成する |
| 検索系 | `POST /api/features/search`, `POST /api/features/business-spatial-search`, `POST /api/features/condition-search` | 中程度 | 空間検索は DB 負荷が高い |
| タイル配信 | `GET /api/tiles/*` | 緩め (正常時も高頻度) | 地図操作 1 回で数十リクエスト飛ぶ。閾値は他より 1 桁以上大きく取る |

補足: 認可されないリクエストは API が 401/403 で早期に落とすため、WAF は
「認証済みでも過剰な頻度」を弾く二段目として設計する。
