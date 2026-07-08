# データ永続化とバックアップ・リストア (AWS 前提)

本番 (ECS Fargate) のデータ永続化は「DB は RDS、アップロードファイルは S3」に集約する
(issue #17)。リポジトリ側の実装は S3 経路 (`UploadStorage.kt` / `worker.py` の `fetch_upload`) で
完了しており、本ドキュメントは **AWS 側 (インフラ責務) の設定とリストア runbook** をまとめる。

## 構成の全体像

| データ | 置き場所 | バックアップ手段 |
|---|---|---|
| PostgreSQL / PostGIS (app.* / gis_data.*) | RDS for PostgreSQL (PostGIS 拡張) | RDS 自動バックアップ + **PITR** (WAL 連続アーカイブ)。スナップショット保持・クロスリージョンコピーも RDS 側設定 |
| アップロードファイル (取込元) | S3 バケット (`UPLOAD_STORAGE=s3`) | S3 バージョニング + (必要なら) クロスリージョンレプリケーション |
| コンテナのローカル FS | ECS タスク (揮発) | **バックアップ不要** (multipart 受信のステージングと S3 ダウンロードの一時ファイルのみ) |

この構成により **EBS / EFS / docker volume のバックアップは不要になる**。
compose のホスト `./data` volume 共有はローカル開発専用の経路 (`UPLOAD_STORAGE=local`) として残る。

## アプリ側の動作 (前提知識)

- api は multipart をローカルへステージングして上限検査した後、`UploadStorage` へ保存する。
  S3 モードではジョブ行 `app.import_jobs.upload_path` に `s3://<bucket>/<key>` を記録する
  (ローカルモードは従来どおり絶対パス。参照が自己記述的なためスキーマ変更はない)
- worker-gis は `upload_path` が `s3://` のとき boto3 で一時ファイルへダウンロードして
  ogr2ogr に渡し、処理後に一時ファイルだけを削除する
- **アップロード本体は取込の成功/失敗後も削除しない** (ローカル時代からの踏襲。再取込・調査に使える)。
  溜まり続ける分の失効は S3 ライフサイクルルールに委譲する (下記)

## S3 バケット設定 (インフラ責務)

- **バージョニング有効化** (誤削除・上書きからの復旧)
- **ライフサイクルルール**: アップロードは取込後に参照されなくなるため、例として
  「`uploads/` プレフィックスを 7 日で失効 (Expiration)、非カレントバージョンは 30 日で削除」。
  取込失敗の調査猶予を勘案して期間は運用で調整する
- **パブリックアクセスブロック有効** / バケットポリシーで api・worker のタスクロールのみ許可
- 必要な RPO に応じてクロスリージョンレプリケーション (CRR) を有効化
- IAM (タスクロール): api は `s3:PutObject` / `s3:GetObject` / `s3:DeleteObject` / `s3:HeadObject`、
  worker は `s3:GetObject` を対象バケットの `uploads/*` に限定して付与する

## RDS 設定 (インフラ責務)

- 自動バックアップ有効化 (保持期間は RPO/RTO 目標から決める。例: 14 日)
- PITR は自動バックアップに含まれる (5 分粒度の WAL アーカイブ)
- 必要に応じて手動スナップショットの世代管理・クロスリージョンコピー (AWS Backup へ集約可)
- PostGIS 拡張は RDS サポート済み。`CREATE EXTENSION` は DBA (マスターユーザー) が
  事前に実行する ([db-migrations.md](db-migrations.md) の拡張の節を参照)

## リストア runbook (PITR)

DB とアップロードは独立に保全されるため、復旧は「DB を特定時点へ戻す → S3 との整合を確認する」の
2 段で行う。

1. **復旧時点の決定**: 事故発生時刻の直前 (例: 誤 DELETE の 1 分前) を決める
2. **RDS PITR 復元**: `aws rds restore-db-instance-to-point-in-time` で**新インスタンス**として
   復元する (in-place ではない)。パラメータグループ・セキュリティグループ・サブネットグループは
   明示指定が必要
3. **アプリの切替**: Secrets Manager / SSM の接続先 (`DATABASE_URL` / `PGHOST`) を新エンドポイントへ
   更新し、api / worker / martin を `aws ecs update-service --force-new-deployment` で再起動する。
   Flyway は起動時に `app.flyway_schema_history` を確認するだけで、復元時点のスキーマが
   そのまま使える (再適用は発生しない)
4. **S3 との整合確認** (アップロードはバケット側が正):
   - **欠損検出**: 復旧時点以降に完了していた取込ジョブは DB 巻き戻しで pending に戻り、worker が
     再実行する。その際 `upload_path` の S3 オブジェクトがライフサイクルで失効済みだと失敗する →
     `SELECT id, upload_path FROM app.import_jobs WHERE status IN ('pending','running')` の参照先を
     `aws s3api head-object` で確認し、失効済みならジョブを failed にして再アップロードを依頼する
   - **孤児検出**: 復旧時点より後にアップロードされたオブジェクトは DB に対応するジョブ行が無い
     (孤児)。実害はなくライフサイクルで自然消滅するが、即時に消す場合は `uploads/` の一覧と
     `app.import_jobs.upload_path` を突き合わせて削除する
5. **動作確認**: `scripts/smoke-e2e.sh` 相当の「取込 → 検索 → タイル配信」を復旧環境で実行する

## RPO / RTO 目標 (明文化)

| 対象 | RPO | RTO | 根拠 |
|---|---|---|---|
| DB (RDS PITR) | 5 分 | 1 時間 | PITR の WAL アーカイブ粒度 / PITR 復元 + ECS 切替の実測を上限とする |
| アップロード (S3) | 0 (リージョン内。CRR 有効時はリージョン障害でも分単位) | DB 復旧に同伴 | S3 の耐久性に委譲。取込済みデータは DB 側に実体化されているため、アップロード原本の喪失は再取込可否にのみ影響する |

- **リストア演習を四半期ごとに実施する**: 上記 runbook で staging に PITR 復元し、
  smoke E2E が通ること・所要時間が RTO 内であることを記録する。演習で使った
  復元インスタンスは即時削除する
- 演習と手順の乖離が出たら本ドキュメントを同じ PR で更新する

## 将来課題 (issue #17 の残項目)

- **presigned URL による直接アップロード**: 現在は api 経由の multipart (最大 200MB) を
  ステージングしてから S3 へ転送する。帯域をアプリから外すには presigned POST/PUT へ移行し、
  ジョブ登録 API と分離する (S3 化が済んだため追加実装は小さい)
- zip 展開検査 (issue #19) は worker のダウンロード方式 (ローカル実体がある) を前提にできる
