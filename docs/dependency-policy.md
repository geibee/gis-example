# フロントエンド依存ライブラリの選定・サプライチェーン運用ポリシー

近年の npm サプライチェーン攻撃 (2026-05 TanStack/router 侵害、2025-09 chalk 侵害、2026-03 axios 侵害等) を踏まえた本リポジトリの方針。

## 基本方針: 二層構造

**ライブラリ選定ではサプライチェーン攻撃を守りきれない。** 攻撃で悪用される要素 (`pull_request_target`、Actions キャッシュポイズニング、OIDC トークン抽出、長期 npm トークン) は OSS 全般が共有する構造的攻撃面であり、「侵害履歴の有無」は将来の安全を保証しない。

したがって:

1. **ライブラリは機能・DX で選ぶ** — サプライチェーン懸念は決定要因にしない
2. **セキュリティは運用層で担保する** — 本リポジトリで実施している対策:

| 対策 | 実装箇所 |
|---|---|
| インストールスクリプト無効化 (`ignore-scripts=true`) | `.npmrc` |
| リリース冷却期間 7 日 (`min-release-age=7`) | `.npmrc` (npm 11.6+) |
| 新規依存の完全バージョン固定 (`save-exact=true`) | `.npmrc` |
| lockfile 必須 (`npm ci` のみで再現) | `package-lock.json` + CI |
| Dependabot cooldown 7 日 | `.github/dependabot.yml` |
| GitHub Actions の commit SHA ピン留め | `.github/workflows/*.yml` |
| `pull_request_target` 不使用 | 全ワークフロー (使用禁止) |
| SBOM 生成・脆弱性スキャン | nightly (Trivy / SBOM / gitleaks) |

### ワークフロー編集時の注意

- third-party / 公式問わず action は **commit SHA でピン留め**し、末尾コメントにバージョンを記す
- `pull_request_target` は使わない (fork コードがベースリポジトリ権限で動く "Pwn Request" の温床)
- `actions/cache` の追加は避ける (ポストジョブ保存が `permissions:` でゲートされずキャッシュポイズニングに悪用された事例あり)

## ライブラリ選定基準 (機能・DX)

新規依存の追加時は以下を確認する:

- ランタイム依存の深さ (`npm ls --all` で実測。依存極小が望ましい)
- インストール時スクリプトの有無 (`ignore-scripts=true` で動作するか)
- メンテナ体制 (実質シングルメンテナの基盤ライブラリは避ける)
- 再代替可能性 (侵害・放棄時に剥がすコスト)

### フォームライブラリの選定指針 (本リポジトリ = Vite SPA)

| フォームの性格 | 採用 |
|---|---|
| 典型フォーム (ログイン・設定・検索・CRUD) | React Hook Form |
| 動的ネスト配列が中核の複雑編集フォーム | TanStack Form |

両者の同居は問題ない。RHF では `useWatch` の全体購読を避け、購読範囲の限定・計算の子コンポーネント隔離・`register` 優先を徹底する。

### ルーター / サーバ状態

- ルーター: TanStack Router (型安全なルート定義・検索パラメータ。数百画面規模での保守性を優先)
- サーバ状態: TanStack Query

2026-05 の侵害は `@tanstack/router*` の旧バージョンで発生したが、`min-release-age` と lockfile 固定により同型の攻撃 (公開直後の悪意あるバージョン) は取り込まれない。事件後の TanStack 側の公開フロー強化 (pull_request_target 全廃・SHA ピン・actions/cache 廃止) も確認済み。

### Zod のコンテナ検証 (CVE-2023-54404)

- Zod を 4.6.6 に固定する。上流の修正は、配列・Set・Map に明示した上限を要素の検証より前に評価するもの。
  **上限なしのコンテナは更新だけでは保護されない**ため、今後コンテナスキーマを追加する場合は入力仕様に応じた `.max()` / `.length()` / `.size()` を宣言し、過大入力の拒否もテストする。
- 現在のアプリの Zod 利用は `PartyForm.tsx` の文字列フィールドを持つ object スキーマのみで、配列・Set・Map のスキーマは使っていない。今回、業務入力への新しい上限は導入しない。
- `apps/web/src/security/zod-bounds.test.ts` は、明示した配列上限を超える入力を要素走査なしに拒否することと、上限内の既存動作を検証する。
- 参考: [上流修正 #6652](https://github.com/colinhacks/zod/pull/6652)、[GitHub Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。Trivy の除外や重大度ゲートの緩和は行わない。
