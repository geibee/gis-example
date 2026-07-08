# 環境変数一覧とシークレット管理 (AWS 前提)

本リポジトリの全コンポーネントは**環境変数駆動**で設定される。このドキュメントは
ECS タスク定義を作成するときの完全なインプットとして、全設定項目を
「名称 / 必須・任意 / dev 既定 / 本番の供給元」で一覧化する。

## 前提 (実行基盤とシークレットの正本)

- 実行基盤は **ECS Fargate** を想定する (動的 MVT タイルのバースト・長時間取込ジョブ・日中定常負荷というワークロード特性による。詳細は issue #16)
- シークレットの正本は **AWS Secrets Manager** (DB 資格情報は RDS 統合ローテーション対象)。シークレットでない設定値は **SSM Parameter Store**、環境ごとに固定の値は**タスク定義の `environment` 直書き**でよい
- 注入は ECS タスク定義の `secrets` (`valueFrom`) を使う。アプリからは従来どおり環境変数に見えるため、**アプリコードの変更は不要**
- AWS への認証は IAM タスクロール。CI からは GitHub Actions OIDC フェデレーション (長期アクセスキー不使用)
- **`infra/docker-compose.yml` はローカル開発専用**。本番構成には使わない。dev の資格情報は `infra/.env` (gitignore 済み、`infra/.env.example` をコピーして作成) から供給する

供給元の凡例:

| 凡例 | 意味 |
|---|---|
| Secrets Manager | ECS タスク定義 `secrets.valueFrom` で Secrets Manager から注入 (ローテーション対象) |
| SSM | ECS タスク定義 `secrets.valueFrom` で SSM Parameter Store から注入 (シークレットではない設定値) |
| タスク定義 | ECS タスク定義 `environment` に直書き (環境ごとに固定・秘匿不要) |
| ビルド引数 | コンテナイメージのビルド時に確定 (実行時には変更不可) |

## api (apps/api — Ktor)

ソース: `Application.kt` / `Database.kt` / `Auth.kt` の `System.getenv`。

| 名称 | 必須 | dev 既定 (未設定時) | 本番の供給元 |
|---|---|---|---|
| `PORT` | 任意 | `8080` | タスク定義 |
| `DATABASE_URL` | 任意 (本番は明示) | `jdbc:postgresql://localhost:5432/gis` | タスク定義 (RDS エンドポイント) |
| `DATABASE_USER` | 任意 (本番は明示) | `PGUSER` → `gis` | Secrets Manager (RDS シークレットの `username`) |
| `DATABASE_PASSWORD` | **必須** (`PGPASSWORD` でも可。既定へのフォールバックなし — 未設定は起動失敗) | なし (compose が注入) | **Secrets Manager** (RDS シークレットの `password`) |
| `DATABASE_POOL_SIZE` | 任意 | `10` | タスク定義 |
| `DATABASE_CONNECTION_TIMEOUT_MS` | 任意 | `10000` | タスク定義 |
| `DATABASE_MAX_LIFETIME_MS` | 任意 | `1500000` (25 分) | タスク定義 |
| `DATABASE_LEAK_DETECTION_MS` | 任意 | `60000` | タスク定義 |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 任意 | `30000` | タスク定義 |
| `HEAVY_STATEMENT_TIMEOUT_MS` | 任意 | `0` (無制限。分析ジョブ等の重い処理で statement_timeout を差し替える) | タスク定義 |
| `UPLOAD_DIR` | 任意 (本番は明示) | `/tmp/web-gis-uploads` | タスク定義 (EFS 等の永続ボリュームを指す) |
| `UPLOAD_MAX_BYTES` | 任意 | `209715200` (200MB。web の nginx `client_max_body_size` と揃える) | タスク定義 |
| `API_PUBLIC_URL` | 任意 (本番は明示) | `http://localhost:8080` | タスク定義 / SSM |
| `WEB_ORIGIN` | 任意 (本番は明示。未設定時も anyHost には開放しない) | `http://localhost:5173` | タスク定義 / SSM |
| `OIDC_ISSUER` | **必須** (未設定は起動失敗) | なし (compose が注入) | タスク定義 / SSM |
| `OIDC_AUDIENCE` | **必須** (未設定は起動失敗) | なし (compose が注入) | タスク定義 / SSM |
| `OIDC_JWKS_URL` | 任意 | `$OIDC_ISSUER/protocol/openid-connect/certs` | タスク定義 / SSM |
| `AUTH_ADMIN_EMAILS` | 任意 (初期 system admin のブートストラップ用。カンマ区切り) | なし | SSM |
| `ANALYSIS_POLL_INTERVAL_SECONDS` | 任意 | `2` | タスク定義 |
| `ANALYSIS_JOB_STALE_SECONDS` | 任意 | `1800` | タスク定義 |

## worker-gis (apps/worker-gis — Python)

ソース: `src/worker.py` の `os.getenv`。DB 接続は libpq 標準の `PG*` 変数。

| 名称 | 必須 | dev 既定 (未設定時) | 本番の供給元 |
|---|---|---|---|
| `PGHOST` | 任意 (本番は明示) | `localhost` | タスク定義 (RDS エンドポイント) |
| `PGPORT` | 任意 | `5432` | タスク定義 |
| `PGDATABASE` | 任意 (本番は明示) | `gis` | タスク定義 |
| `PGUSER` | 任意 (本番は明示) | `gis` | Secrets Manager (RDS シークレットの `username`) |
| `PGPASSWORD` | **必須** (既定へのフォールバックなし — 未設定は起動失敗) | なし (compose が注入) | **Secrets Manager** (RDS シークレットの `password`) |
| `POLL_INTERVAL_SECONDS` | 任意 | `2` | タスク定義 |
| `IMPORT_JOB_STALE_SECONDS` | 任意 | `1800` | タスク定義 |

## web (apps/web — ビルド時のみ)

ソース: `src/api.ts` / `src/auth.ts` の `import.meta.env`。Vite の `VITE_*` は
**ビルド時に JS へ埋め込まれる**ため、実行時の環境変数では変更できない。
環境ごとにイメージを分けるか、ビルドパイプラインで環境別に `--build-arg` /
`.env.production` を与える。**シークレットを `VITE_*` に入れないこと** (配布物に平文で残る)。

| 名称 | 必須 | dev 既定 (未設定時) | 本番の供給元 |
|---|---|---|---|
| `VITE_API_BASE` | 任意 | `""` (同一オリジン相対パス) | ビルド引数 |
| `VITE_OIDC_AUTHORITY` | 任意 (本番は明示) | `http://localhost:8081/realms/gis` | ビルド引数 |
| `VITE_OIDC_CLIENT_ID` | 任意 | `gis-web` | ビルド引数 |

## martin (タイルサーバー)

| 名称 | 必須 | dev 既定 | 本番の供給元 |
|---|---|---|---|
| `DATABASE_URL` | **必須** (`postgres://user:pass@host:5432/db` 形式。資格情報を含む) | compose が `POSTGRES_*` から組み立て | **Secrets Manager** (接続文字列全体を 1 シークレットとして注入。パスワード単体のローテーションと整合させるため、RDS シークレットから接続文字列を生成するローテーション Lambda / デプロイ手順に含める) |

## keycloak (dev 専用の IdP コンテナ)

compose 内の Keycloak はローカル開発専用 (`start-dev` + realm import)。本番は
Keycloak の本番モード運用 (ECS) か Cognito への移行を別途判断する (issue #16)。

| 名称 | 必須 | dev 既定 | 本番の供給元 |
|---|---|---|---|
| `KC_BOOTSTRAP_ADMIN_USERNAME` | 任意 | `admin` (`infra/.env`) | (本番で Keycloak を使う場合) Secrets Manager |
| `KC_BOOTSTRAP_ADMIN_PASSWORD` | **必須** (compose では `infra/.env` から) | `admin` (`infra/.env`) | (同上) **Secrets Manager** |
| `KC_HTTP_PORT` | 任意 | `8080` | タスク定義 |

## compose 専用 (infra/.env — ローカル開発のみ)

| 名称 | 説明 | dev 既定 |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | 開発 PostgreSQL の資格情報。api / worker / martin / seed にも同じ値が配線される | `gis` / `gis` / `gis` |
| `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD` | 開発 Keycloak の管理者 | `admin` / `admin` |
| `POSTGRES_HOST_PORT` / `WEB_HOST_PORT` | ホスト側ポートの競合回避 | `5432` / `5173` |

CI / verify 用の変数 (`VERIFY_*`, `SMOKE_*`, `FUZZ_*`) は各スクリプトのヘッダコメントを参照。

## シークレットローテーションの運用

DB 資格情報は Secrets Manager の RDS 統合ローテーションを使う。ただし
**api の HikariCP・worker の psycopg・martin はいずれも起動時に資格情報を読み込む**
ため、ローテーションは次の手順で反映する:

1. Secrets Manager がシークレットをローテーション (RDS 統合)。**alternating users 戦略**
   (2 ユーザーを交互に切替) を使い、旧資格情報がローテーション直後も有効な期間を確保する
2. ローテーション完了イベント (EventBridge) またはローテーション後の運用手順として、
   対象 ECS サービスに **`aws ecs update-service --force-new-deployment`** で
   ローリング再起動をかける。新タスクは起動時に新しいシークレットを注入されて立ち上がり、
   旧タスクはドレイン後に停止する
3. single user 戦略を使う場合、ローテーション瞬間から旧パスワードが無効になるため、
   既存プールの**確立済み接続は生き続ける** (PostgreSQL は接続時のみ認証) が、
   再接続 (`DATABASE_MAX_LIFETIME_MS` 既定 25 分での入替や障害時) に失敗し始める。
   この場合はローテーション → 再デプロイを 1 つの自動化された手順にすること

補足:

- ECS の `secrets` 注入は**タスク起動時**に解決される。シークレット変更は自動では
  反映されず、必ず新タスクの起動 (= ローリング再起動) が必要
- アプリ側にシークレット再読込の仕組みを追加する必要はない (起動時読込 + 再起動反映を正とする)
- OIDC まわり (`OIDC_*`) はシークレットではなく、鍵は JWKS (`OIDC_JWKS_URL`) から
  動的に取得されるため、IdP 側の署名鍵ローテーションに API の再起動は不要

## dev シードの本番混入ガード

開発専用の弱い資格情報・固定ユーザーは以下の 2 か所にのみ存在する:

- `infra/keycloak/realm-gis.json` — 開発 realm (ユーザー `gis-admin` / `gis-editor` / `gis-viewer`、パスワードはユーザー名と同じ)
- `infra/postgres/070-seed-dev-users.sql` — 上記ユーザーの DB 側メンバーシップ (compose の `seed` サービスが投入)

構造上のガード:

- 本番用イメージ (apps/api / apps/worker-gis / apps/web の Dockerfile) は `infra/` を
  一切 COPY しない。realm import・seed サービスは compose のボリュームマウント /
  one-shot サービスであり、イメージには焼き込まれない
- `scripts/check-dev-seed-isolation.sh` が「本番 Dockerfile が infra/ の
  シード・realm を参照しないこと」「開発ユーザーの識別子がアプリ本体コード
  (Flyway マイグレーション含む) に現れないこと」「`infra/.env` がコミットされないこと」を
  検査する。`scripts/verify.sh` に組み込まれており、CI でも毎回実行される
- 本番の初期管理者は seed ではなく `AUTH_ADMIN_EMAILS` による JIT ブートストラップで
  作成し、メンバーシップは管理 API で付与する

## ROPC (Resource Owner Password Credentials) の扱い

開発 realm (`infra/keycloak/realm-gis.json`) の `gis-web` クライアントは
`directAccessGrantsEnabled: true` (ROPC 有効) になっている。これは
`scripts/smoke-e2e.sh` (nightly のスモーク E2E) がヘッドレスで
`grant_type=password` によりアクセストークンを取得するための **dev 専用の妥協**であり、
ブラウザの web アプリ自体は Authorization Code + PKCE のみを使う。

- **本番 realm では `directAccessGrantsEnabled: false` を必須とする** (パスワードが
  クライアント経由で IdP に渡る経路を残さない。フィッシング耐性・MFA 適用の観点でも不可)
- 開発 realm で無効化しない理由: スモーク E2E のトークン取得が ROPC に依存しており、
  代替 (Authorization Code のヘッドレス自動化、またはテスト専用 confidential client +
  client_credentials + ユーザー偽装) は smoke の複雑化に見合わない。dev realm は
  ループバックのみで到達可能な compose 内 Keycloak であり、露出は限定的
- Cognito へ移行する場合も同様に、`ALLOW_USER_PASSWORD_AUTH` を本番 App client で
  有効化しないこと
