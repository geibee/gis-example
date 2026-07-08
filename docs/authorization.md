# 認可モデル (ロール・Permission・Action)

issue #25 の設計ドキュメント。数百画面規模を見据え、認可の語彙を
「エンドポイント単位の Action」と「画面・機能単位の Permission」の 2 層に分離し、
ロールを Permission 集合として宣言する。**既存ロール (admin / user, editor / viewer) の
実効権限は 1 bit も変えていない** (回帰は `AuthzIntegrationTest` と
`PermissionMatrixTest` のゴールデン表が守る)。

## 全体像

```
リクエスト → ルート宣言 (RouteAuthz + Action)          … PEP: AuthorizedRouting / AuthorizationEnforcement
                │
                ▼
          AccessPolicy.allows(principal, action, resource)   … PDP: Authorization.kt (純関数)
                │
                ├─ principal.systemRole == ADMIN → 常に許可 (組込みの破壊不能ルール)
                ├─ resource = System             → admin 以外は常に拒否
                └─ resource = Project(id)
                     role = principal.memberships[id]            … 可変データ (DB: app.project_members)
                     role の Permission 集合 ∋ action.requiredPermission ならば許可
                                                                 … ポリシー (コード宣言)
```

- **Action** — エンドポイントを集約した操作単位 (`LAYER_WRITE` 等)。ルート宣言
  (`RouteAuthz`) と監査ログが参照する PDP 内部の語彙。エンドポイント追加時は必ず
  いずれかの Action へ割り当てる (認可宣言のないルートは起動時検証で落ちる)
- **Permission** — 画面・機能単位の権限キー (`layers.manage` 等)。ロール定義と
  フロントの出し分けが参照する外向きの語彙。`Action.requiredPermission` が
  Action → Permission の全域写像を宣言する (when の網羅性 + テストで漏れを強制)
- **ロール** — Permission 集合への名前付け。`BuiltinRoleDefinitions` がコードで宣言する

「可変データ (誰がどのプロジェクトのメンバーか) は DB に、ポリシー (ロールが何を
できるか) はコードに」という従来の設計原則は維持する。

## Permission 一覧と Action の対応

| Permission キー | 意味 (画面・機能) | 対応 Action |
|---|---|---|
| `projects.view` | プロジェクト一覧・切替 | `PROJECT_READ` |
| `layers.view` | レイヤ一覧・属性定義の閲覧 | `LAYER_READ` |
| `layers.manage` | レイヤの改名・削除・結果セット操作・ゾーン化 | `LAYER_WRITE` |
| `map.view` | 地図表示 (ベクタタイル・地物・検索) | `FEATURE_READ`, `TILE_READ` |
| `features.edit` | 地物属性の編集 | `FEATURE_WRITE` |
| `business-data.view` | 業務データ (土地・建物・関係者・ゾーン) の閲覧 | `BUSINESS_READ` |
| `business-data.edit` | 業務データの作成・更新・削除・関係付け | `BUSINESS_WRITE` |
| `import.run` | GIS ファイル取込の実行 | `IMPORT_EXECUTE` |
| `analysis.run` | 空間分析の実行 | `ANALYSIS_EXECUTE` |
| `jobs.view` | 取込・分析ジョブの進捗閲覧 | `JOB_READ` |
| `admin.users.manage` | ユーザー管理 (system 管理画面) | `USER_ADMIN` |
| `admin.members.manage` | プロジェクトメンバー管理 (system 管理画面) | `MEMBER_ADMIN` |

粒度の指針: **Permission は「管理者がロール設計時に意味を説明できる」単位**で切る。
エンドポイントの都合 (Action) より粗く、「編集できる」のような 2 値より細かく。
現行 UI のタブ構成 (地図 / ゾーン / 土地 / 建物 / 関係者 / 管理) では業務 4 タブが
`business-data.*` を共有するが、将来タブごとに権限を分けたくなったら
`BUSINESS_READ` を `LAND_READ` 等へ分割し、Permission も `lands.view` 等へ分ける
(ゴールデン表の更新 = 意図的な権限変更のレビュー点になる)。

## ロール定義

| ロール | 種別 | Permission |
|---|---|---|
| system `admin` | システム | 全 Permission (組込みの破壊不能ルール。PDP が無条件許可) |
| system `user` | システム | なし (プロジェクトロールに従う) |
| project `viewer` | プロジェクト | `projects.view` `layers.view` `map.view` `business-data.view` `jobs.view` |
| project `editor` | プロジェクト | viewer + `layers.manage` `features.edit` `business-data.edit` `import.run` `analysis.run` |

新しいロール (例: 取込オペレータ = viewer + `import.run` + `jobs.view`) の追加は
`Authorization.kt` の `BuiltinRoleDefinitions` への宣言追加のみで完結する。ただし
`project_members.role` の CHECK 制約 (`V1__baseline.sql`) と管理 API のバリデーション
(`UserQueries.putProjectMember`) にロール名を足すマイグレーション・変更が必要
(ロール名も契約の一部として fail-closed に保つため)。

## テストによる固定 (ゴールデンマトリクス)

意図しない権限変化を「テストの差分」として顕在化させる。

- `PermissionMatrixTest` — ポリシー宣言そのものを文字列リテラルの表で固定する
  - Action → Permission 写像のゴールデン表 (全 Action の割り当て漏れも検出)
  - ロール → Permission 集合のゴールデン表
  - ロール × Action の実効マトリクスのゴールデン表と、`allows()` 判定との一致
- `AccessPolicyTest` — PDP の振る舞い網羅 (admin 全許可・非メンバー拒否・システム
  リソースの隔離・メンバーシップゼロの既定拒否)
- `AuthzIntegrationTest` — HTTP 層での配線 (403/404 の使い分け・監査ログ) を実 DB で検証

権限を意図して変える PR は、ゴールデン表の更新が必ず diff に現れる。

## ロール → Permission マッピングの管理方式: コード宣言を維持する (決定)

issue #25 の選択肢「DB 管理 (管理画面から編集可能) にするか、コード宣言のままにするか」
は**コード宣言を維持**と決定した。根拠:

1. **受け入れ条件との整合** — 「新しいロールの追加がポリシー定義の変更のみで完結し、
   全 Action との対応がテストで網羅される」は、宣言がコードにありテストと同じ
   リポジトリでレビュー・CI される形が最も強く満たす。DB 管理にすると権限変更が
   コードレビューとゴールデンテストの外へ出る
2. **監査可能性** — 権限変更が git 履歴 = 変更管理プロセスに乗る。DB 管理では
  監査ログ・変更承認フローを別途作る必要がある
3. **現時点の要求** — 必要なのは「ロールを増やせる表現力」であり、「実行時に権限を
   編集できる機能」ではない。テナントごとにロールが異なる SaaS 的要求が出た時点で
   DB 化する (下記の布石を参照)

### 将来 DB 化 (カスタムロール) する場合の設計

`RolePermissionResolver` インタフェースが差し替え点。DB 実装へ移す場合:

```sql
-- ロール定義 (テナント/システム管理者が管理画面から編集)
CREATE TABLE app.roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    description text,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- ロールが持つ Permission (キーは Permission.key。未知キーは起動時検証で拒否)
CREATE TABLE app.role_permissions (
    role_id uuid NOT NULL REFERENCES app.roles(id) ON DELETE CASCADE,
    permission text NOT NULL,
    PRIMARY KEY (role_id, permission)
);
-- project_members.role (text) を app.roles への FK に置き換える
```

移行方針: 組込みロール (viewer / editor) を app.roles へシードし、
`RolePermissionResolver` の DB 実装 (principal 解決時に一括ロードしてキャッシュ) へ
差し替える。`AccessPolicy.allows` の呼び出し面・PEP・監査ログは変えない。
Permission キー自体 (画面・機能の語彙) は引き続きコードが正であり、DB が持つのは
「どのロールがどのキーを持つか」だけにする (未知キーの行は起動時・書込時に拒否して
fail-closed を保つ)。

## フロントエンド (web) への申し送り

現状の web は `me?.systemRole === "admin"` の直判定のみで、機能単位の出し分け基盤が
ない。web 側チェーンで次を行う (この issue では API 契約 (openapi.yaml) を変えて
いないため未着手):

1. `/api/me` のレスポンスへ実効権限を追加する — openapi.yaml の `Me` スキーマに
   `permissions: string[]` (グローバル = system admin 由来) と `memberships[].permissions:
   string[]` (プロジェクトロール由来) を追加し、生成型を再生成する。サーバ側は
   `AccessPolicy.permissionsOf(role)` (この issue で追加済み) から `Permission.key` を
   列挙するだけでよい
2. ルート・画面のメタデータ (staticData 等) に必要 Permission キーを宣言し、
   ルートガードとボタン出し分けを `/api/me` の permissions から導出する —
   「フロントの表示制御とサーバの認可判断が同一の権限情報源から導出される」
   (受け入れ条件) はこれで満たす
3. UI 出し分けはあくまで UX であり、強制は常にサーバ (PEP) が行う (現行どおり)

Permission キーは `Permission.key` (例: `business-data.edit`) を唯一の正とし、
web 側で独自の権限文字列を定義しない。
