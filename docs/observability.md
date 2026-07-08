# 観測性 (ログ・requestId・ヘルスチェック)

ログの収集・保管・検索 (CloudWatch Logs)、基盤メトリクス (ALB/ECS/RDS)、ダッシュボード・
アラームは **AWS 側の責務**として委譲する。ただし CloudWatch は stdout をそのまま収集する
だけなので、「収集されたログが調査に使える形か」はアプリ側の責務として残る (issue #18)。
本ドキュメントはそのアプリ側の仕様 — ログ形式、requestId (callId) の伝播、ヘルスエンド
ポイントの使い分け — を説明する。

## ログ形式 (LOG_FORMAT)

api (Ktor / logback) と worker-gis (Python / logging) は環境変数 `LOG_FORMAT` で
出力形式を切り替える。**不正値は起動失敗** (黙って無ログ・非構造化で走らせない):

| 値 | 用途 | 形式 |
|---|---|---|
| `text` (既定) | dev / compose | 人間可読の 1 行テキスト |
| `json` | **本番 (ECS)** | JSON lines。CloudWatch Logs Insights でフィールド検索できる |

### api の JSON フィールド (logstash-logback-encoder)

```json
{"@timestamp":"2026-07-08T05:19:38.021+09:00","@version":"1","message":"GET /api/projects -> 200 (11ms) from 127.0.0.1","logger_name":"gis.example.AccessLog","thread_name":"eventLoopGroupProxy-4-1","level":"INFO","level_value":20000,"callId":"4f9c2c1e-...","httpMethod":"GET","path":"/api/projects","clientIp":"127.0.0.1","status":"200","durationMs":"11"}
```

- 基本フィールド: `@timestamp` / `level` / `logger_name` / `thread_name` / `message`。
  例外は `stack_trace` に完全なスタックトレースが乗る
- MDC はトップレベルのフィールドとして展開される。リクエスト処理中の**全ログ行**に
  `callId` / `httpMethod` / `path` / `clientIp` が乗り、リクエスト完了時のアクセスログ
  (`logger_name = "gis.example.AccessLog"`、1 リクエスト 1 行) には加えて `status` /
  `durationMs` が乗る
- 分析ジョブ実行中のログ行には `jobId` / `projectId` が乗る (HTTP の callId に相当する
  ジョブ側の相関 ID)
- `/health`・`/health/ready` へのアクセスは監視ノイズなのでアクセスログに出さない

### worker-gis の JSON フィールド

`src/worker.py` の `JsonLinesFormatter` が api とフィールド名を揃えて出力する:
`@timestamp` / `level` / `logger_name` / `message`、例外時の `stack_trace`、
ジョブ関連行の `job_id` / `layer_id` / `project_id`。

### CloudWatch Logs Insights のクエリ例

```
# requestId = X の全ログ (アプリログ + アクセスログ + 例外) を串刺し
fields @timestamp, level, logger_name, message
| filter callId = "4f9c2c1e-..."
| sort @timestamp asc

# エラーのみ
fields @timestamp, callId, message, stack_trace
| filter level = "ERROR"

# 遅いリクエスト
fields @timestamp, httpMethod, path, durationMs, callId
| filter logger_name = "gis.example.AccessLog" and durationMs > 1000

# 特定の分析ジョブの全ログ
fields @timestamp, level, message
| filter jobId = "..."
```

## requestId (callId) の伝播

1 リクエストのログを串刺し検索するための相関 ID。採用順:

1. **受信ヘッダ `X-Request-Id`** — 呼び出し側 (別サービスや curl) が明示した相関 ID
2. **受信ヘッダ `X-Amzn-Trace-Id`** — ALB が必ず付与する trace ID。これを採用すると
   ALB アクセスログ・X-Ray と直接突合できる
3. **自前生成 (UUID)** — 直接アクセスや dev。上記 2 つが無い/不正な場合のフォールバック

クライアント由来の値は検証 (印字可能 ASCII のみ・200 文字以下) を通ったものだけを採用し、
不正値は生成 UUID に置き換える (ログ注入・巨大ヘッダ反射の防止)。採用した callId は:

- **レスポンスヘッダ `X-Request-ID`** で必ず返す (障害報告に添えてもらう ID)
- **MDC `callId`** としてリクエスト処理中の全ログ行に乗る
- **監査ログ `app.audit_logs.call_id`** に記録され、DB 上の監査証跡と CloudWatch Logs 上の
  アプリログを 1 リクエスト単位で突合できる

実装は `apps/api/src/main/kotlin/gis/example/Observability.kt` (Ktor CallId + CallLogging)。

## ヘルスチェックの分離 (liveness / readiness)

| エンドポイント | 意味 | 依存 | 想定する利用者 |
|---|---|---|---|
| `GET /health` | **liveness**: プロセスが応答できるか | なし (DB に触れない) | ECS コンテナヘルスチェック・smoke の起動待ち |
| `GET /health/ready` | **readiness**: トラフィックを受けられるか | DB 疎通 (`SELECT 1`) を `HEALTH_READINESS_TIMEOUT_MS` (既定 2000ms) 以内に確認 | **ALB ターゲットグループのヘルスチェック** |

- **ALB ターゲットグループは `/health/ready` を向けること**。従来の `/health` は固定応答
  なので DB 断を検知できず、死んだタスクへルーティングし続ける
- liveness に DB チェックを入れない理由: DB 障害時に全タスクが「異常」と判定されて
  再起動ループに入るのを防ぐ。DB 断はタスクを殺しても直らない — readiness で
  ルーティングから外すのが正しい対処
- readiness の失敗は 503 (`{"status":"unavailable"}`) と WARN ログ。応答は必ず
  `HEALTH_READINESS_TIMEOUT_MS` 以内に返る (JDBC のブロッキング接続待ちは打ち切って応答する)
- 両エンドポイントとも認証不要 (`unauthenticatedGet` の明示的な許可リスト経由で登録。
  起動時検証 issue #14 の対象)

## メトリクスについて (本 issue の範囲外)

HikariCP プール・ジョブ滞留数・HTTP レイテンシ等のアプリ内部メトリクスの本格計装
(Micrometer + CloudWatch EMF / ADOT) は、ジョブ基盤の SQS 化 (issue #24) と併せて別途
判断する。それまでは本ドキュメントの構造化ログを CloudWatch Logs Insights で集計する
(`durationMs` による HTTP レイテンシ、`jobId` 行の時間差によるジョブ所要時間など) ことを
一次手段とする。

## CloudWatch 側の想定 (インフラ責務のメモ)

- ECS タスク定義は `awslogs` ドライバ (または FireLens) で stdout を CloudWatch Logs へ送る。
  アプリは**ファイルにログを書かない** (stdout のみ)
- ロググループはサービス単位 (api / worker-gis)、保持期間はコンプライアンス要件に合わせて設定
- アラーム例: `level = "ERROR"` のメトリクスフィルタ、ALB `HealthyHostCount`、
  5xx 率。ダッシュボード・アラームの定義はインフラ側リポジトリの責務
