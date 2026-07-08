-- DB 初回作成時 (docker-entrypoint-initdb.d) にのみ実行される初期化スクリプト。
-- superuser 権限が必要な「拡張」と、initdb 時のシード (010) が前提とする
-- 「スキーマ」の作成だけを行う。
--
-- テーブル DDL はここに書かない。DDL の SSoT は Flyway マイグレーション
-- (apps/api/src/main/resources/db/migration/V*.sql) で、API 起動時に適用される。
-- app テーブルに依存するシード (020/040/050/060/070) はテーブル作成後に
-- compose の seed サービス (seed-dev-data.sh) が投入する。
-- 運用ルールは docs/db-migrations.md
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS gis_data;
