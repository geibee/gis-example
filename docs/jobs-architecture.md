# ジョブ実行基盤 (SQS + ECS) の設計

issue #24 の実装ドキュメント。取込ジョブ (`app.import_jobs` / worker-gis) と
分析ジョブ (`app.analysis_jobs` / analysis-worker) の実行を API プロセスから分離し、
ディスパッチを SQS 化した。**ジョブの正本は現行どおり Postgres のジョブ行**であり、
SQS は「pending 行ができた」という起動通知に限定する (キューと DB の二重正本化を避ける)。

## 構成

```
                    INSERT + COMMIT          SendMessage (起動通知のみ)
  ブラウザ → api ──────────────→ Postgres ←──┐
                    │                (正本)     │ claim (SKIP LOCKED) / heartbeat / 結果
                    └─→ SQS analysis-jobs ──→ analysis-worker (ECS サービス, 0..N)
                    └─→ SQS import-jobs   ──→ worker-gis      (ECS サービス, 0..N)
                          │ maxReceiveCount 超過
                          └─→ *-dlq (監視用)
```

- **api**: ジョブ行の INSERT がコミットされた後に SQS へ enqueue する (`JobQueue.kt`)。
  enqueue の失敗はエラーにしない (ジョブ行が正本。補完スキャンが回収する)
- **analysis-worker**: `apps/api` と同じイメージの別エントリポイント
  (`gradle installDist` の `bin/analysis-worker` = `AnalysisWorkerMain.kt`)
- **worker-gis**: 従来の Python worker に SQS consume モードを追加 (`JOB_QUEUE_MODE=sqs`)
- **dev / CI**: SQS は ElasticMQ (compose `--profile sqs` / テスト内蔵) で代替する

## モード (dev 互換)

| 環境変数 | 値 | 意味 |
|---|---|---|
| `JOB_QUEUE_MODE` | `polling` (既定) | 従来どおり。api は enqueue せず、各ワーカーは DB ポーリングで claim する |
| | `sqs` | api はジョブ作成コミット後に SQS へ起動通知。ワーカーは SQS を long polling で consume する |
| `ANALYSIS_RUNNER_MODE` | `in-process` (既定) | 分析ランナーを API プロセス内デーモンスレッドで動かす (dev / 単一ホスト) |
| | `external` | API 側のランナーを止め、独立サービス (`bin/analysis-worker`) に任せる |

既定 (未設定) は現行どおりの dev 挙動。**本番 (ECS) は `JOB_QUEUE_MODE=sqs` +
`ANALYSIS_RUNNER_MODE=external`** とし、ジョブ投入からピックアップまでのレイテンシを
ポーリング間隔に依存させない。dev で SQS 経路を試す手順は `infra/.env.example` を参照
(`--profile sqs` で ElasticMQ と analysis-worker が起動する)。

## 実行保証の 5 層 (issue #24) と実装の対応

SQS は at-least-once (重複・消失・順序逆転があり得る) なので、保証は SQS ではなく
**Postgres のジョブ台帳を唯一の正**として次の 5 層で組む。

| 層 | 保証 | 実装 |
|---|---|---|
| 1. 投入 | INSERT コミット時点で「実行されるべき仕事」が確定。enqueue 消失は補完スキャンが回収 (検知遅延の上限 = スイープ間隔 + pending 滞留閾値) | api: `JobRoutes.kt` がコミット後に `JobDispatcher.notify*` (失敗は WARN のみ)。ワーカー: `sweepNow` / `sweep_import_jobs` が `pending かつ created_at < now() - REENQUEUE_SECONDS` の行を再 enqueue |
| 2. 重複実行の防止 | 実行開始は DB 上の原子的 claim のみ。重複配信は claim に失敗して捨てられる (効果としての exactly-once) | `claimAnalysisJobById` / `claim_import_job_by_id` (`UPDATE ... WHERE id = ? AND status='pending' ... FOR UPDATE SKIP LOCKED`)。claim 失敗時はメッセージ削除のみ |
| 3. 実行中クラッシュからの回復 | ハートビート途絶した running 行をスイープが pending へ戻し、再配信 or 補完スキャンで別ワーカーが拾う | claim 時に `heartbeat_at = now()`、実行中は `*_JOB_HEARTBEAT_SECONDS` (既定 15 秒) ごとに更新 + SQS `ChangeMessageVisibility` 延長。スイープは `COALESCE(heartbeat_at, started_at) < now() - *_JOB_STALE_SECONDS` を回収 (V4 マイグレーション) |
| 4. 結果の原子性 | 結果の書込みと `status='succeeded'` を同一トランザクションでコミット。再実行は常に安全 | 現行実装を維持 (`executeClaimedAnalysisJob` / `run_import_job` の不変条件)。SQS 化で変更なし |
| 5. 収束 | 全ジョブが有限時間で succeeded / failed のどちらかに必ず収束する | claim ごとに `attempt_count` をインクリメントし、スイープが「途絶 かつ `attempt_count >= *_JOB_MAX_ATTEMPTS` (既定 5)」を failed 化。SQS 側は maxReceiveCount=5 超過で DLQ へ隔離 (下記) |

時刻閾値 (`started_at`) だけで stale 判定していた旧実装の「閾値を超える長時間の正常実行を
誤って再キューする」問題は、実行中に更新され続けるハートビート基準に置き換えたことで解消した。

### DLQ とジョブ行 failed 化の設計判断

failed 化の判定は **SQS の receiveCount ではなく DB の `attempt_count` を正とする**
(consumer 側 receiveCount 判定でも DLQ ポーリングでもなく、第 3 の案)。理由:

- 補完スキャンが再 enqueue すると新しいメッセージの `ApproximateReceiveCount` は 1 にリセット
  される。receiveCount 基準では「クラッシュ → DLQ → 再 pending → 新メッセージ」のループを
  断ち切れず、収束を保証できない
- `attempt_count` は claim (= 実行開始の事実) と同一トランザクションで進む DB 内の値であり、
  メッセージの経路 (初回 enqueue / 再配信 / 補完スキャン) に依存しない
- failed 化はワーカーの通常スイープに載るため、DLQ を読む常駐プロセスが不要

DLQ (maxReceiveCount=5) はこの設計では**収束のための機構ではなく隔離と監視のための機構**になる:
visibility timeout 内に削除されないメッセージ (= ワーカーのクラッシュ多発や処理の異常長期化) を
本流キューから退避し、`ApproximateNumberOfMessagesVisible` のアラームで人間に知らせる。
DLQ に落ちたメッセージのジョブ行は、上記スイープが有限時間内に pending へ戻すか failed 化している。

## 運用設計値 (CloudWatch / Auto Scaling へのインプット)

### キュー設定 (analysis-jobs / import-jobs 共通)

| 設定 | 値 | 根拠 |
|---|---|---|
| visibility timeout | 120 秒 | ハートビート間隔 15 秒 + `ChangeMessageVisibility` 延長 (`*_VISIBILITY_EXTENSION_SECONDS`=120) の余裕。短くしすぎると処理中の再配信 (claim 失敗のノイズ) が増える |
| receive wait (long polling) | 10 秒 | 空受信の API コール削減。スイープ実行のためこの周期でループが回る |
| maxReceiveCount | 5 | `*_JOB_MAX_ATTEMPTS` (既定 5) と対で保つ |
| DLQ | `analysis-jobs-dlq` / `import-jobs-dlq` | 保持 14 日 (最大)。中身は起動通知 (jobId) のみで再駆動は補完スキャンが担うため、DLQ redrive は原則不要 |

### 不変条件の監視 (アラーム)

「保証が守られていること」の運用上の証明として、次の 3 つをメトリクス化する:

| メトリクス | 取得方法 | 警告 / 危険 閾値 (案) | 意味 |
|---|---|---|---|
| pending 最大滞留時間 | 定期クエリ `SELECT max(now() - created_at) FROM app.*_jobs WHERE status='pending'` を CloudWatch カスタムメトリクスへ (Lambda or ECS scheduled task) | > 10 分 / > 30 分 | 第 1 層の破れ (enqueue 消失が回収されていない、またはワーカー全滅・スケール不足) |
| ハートビート途絶 running 数 | `SELECT count(*) FROM app.*_jobs WHERE status='running' AND COALESCE(heartbeat_at, started_at) < now() - interval '30 minutes'` | ≥ 1 (警告) | 第 3 層の破れ (スイープが動いていない。スイープはワーカー内で動くため、ワーカー全停止の検知にもなる) |
| DLQ 深度 | SQS 標準メトリクス `ApproximateNumberOfMessagesVisible` (各 `*-dlq`) | ≥ 1 (警告) / ≥ 10 (危険) | 毒メッセージ・クラッシュ多発の隔離が起きている |

補助: `ApproximateAgeOfOldestMessage` (本流キュー) > 5 分で「consumer が追いついていない」、
ECS `RunningTaskCount` = 0 (ワーカーサービス) で「実行基盤の全停止」。

### ECS Service Auto Scaling (キュー深度ベース)

並列度はプロセス内 1 に固定し (claim の SKIP LOCKED により複数タスクでも安全)、
スケールは**タスク数**で行う:

| 項目 | analysis-worker | worker-gis |
|---|---|---|
| スケーリング指標 | backlog per task = `ApproximateNumberOfMessagesVisible` ÷ RunningTaskCount | 同左 |
| 目標値 | 3 (1 タスクあたり滞留 3 件で増設) | 2 (取込は 1 件が重い) |
| 最小 / 最大タスク数 | 1 / 10 | 1 / 5 |
| スケールイン | 目標維持 (target tracking) に委譲。長時間ジョブ保護に ECS の task scale-in protection を使うか、SIGTERM 猶予 (`stopTimeout`) を visibility timeout と同程度にする | 同左 |

最小タスク数を 0 にできる設計 (キュー空で完全停止) も可能だが、スイープ (第 1・3 層) が
ワーカー内で動くため、**最小 1 タスクを維持する**。0 にする場合はスイープを
EventBridge Scheduler + 軽量タスクへ外出しすること。

## 検証 (CI)

回帰は使い捨て PostGIS + インプロセス SQS エミュレータで守る (どちらも既存 CI の
integration ジョブで動く。追加のサービスコンテナ不要):

- api: `JobQueueSqsIntegrationTest` (gradle integrationTest、SQS は埋め込み ElasticMQ)
- worker: `tests/integration/test_sqs_queue.py` (pytest -m integration、SQS は moto server)

いずれも「enqueue → consume → claim → succeeded」「処理中の強制 kill → 別ワーカーが回収し
二重実行なしに収束」「同一メッセージの二重配信が無害」「試行上限超過の failed 化」
「pending 滞留の再 enqueue」を検証する。kill テストはワーカーを実プロセスとして起動し
SIGKILL する (テスト専用フック `ANALYSIS_TEST_CLAIM_HOLD_MILLIS` /
`IMPORT_TEST_CLAIM_HOLD_SECONDS` で claim 直後に実行を保留させて再現する)。

## 関連

- 環境変数の一覧: [environment-variables.md](environment-variables.md)
- 構造化ログ (jobId の MDC 伝播): [observability.md](observability.md)
- スキーマ変更 (V4 `heartbeat_at` / `attempt_count`): [db-migrations.md](db-migrations.md)
