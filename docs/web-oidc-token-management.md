# web: OIDC トークン管理 (保管場所・silent renew)

対象: `apps/web` の認証設定 (`src/auth.ts` / `src/AuthGate.tsx` / `src/api.ts`)。issue #20 の対応記録。

## 保管方式: in-memory (`InMemoryWebStorage`)

| 方式 | XSS 耐性 | リロード | 備考 |
| --- | --- | --- | --- |
| localStorage (旧実装) | なし (全タブ分を一括窃取可能) | 保持 | |
| sessionStorage | なし (当該タブ分を窃取可能) | 保持 | oidc-client-ts の既定 |
| **in-memory (採用)** | ストレージ経由の窃取は不可 | 消える → silent サインインで回復 | 実行中メモリを読む XSS には勝てない (どの方式でも同じ) |

採用理由:

- CSP (`script-src 'self'` 等、TLS 対応ブランチで導入) を第一の防壁としつつ、CSP をすり抜ける
  XSS があっても「ストレージを読むだけでトークンが漏れる」経路を塞ぐ。多層防御の位置づけ。
- in-memory の弱点 (リロードでトークン消失) は、IdP の SSO Cookie を使った silent サインイン
  (`prompt=none` の iframe → `silent-renew.html`) で回復する。SSO セッションが生きていれば
  リロード後も資格情報の再入力なしで復帰し、silent が失敗したときだけリダイレクトログインへ落ちる。
- リダイレクトになった場合も、現在の URL を `signinRedirect` の `state.returnTo` に載せて
  ログイン後に元の画面へ復帰する (`onSigninCallback`)。
- 将来 XSS 耐性をさらに上げるなら BFF パターン (トークンをサーバ側セッションに置く) が次段。

## silent renew

- `automaticSilentRenew: true`: アクセストークン失効の 60 秒前 (oidc-client-ts 既定) に
  refresh token でバックグラウンド更新する。realm の `accessTokenLifespan` は 900 秒なので、
  タブを開いている限り約 14 分間隔で更新され、フルリダイレクトは発生しない。
- refresh token が使えない場合 (期限切れ等) は `silent_redirect_uri`
  (`/silent-renew.html`、専用の最小エントリ) を使った iframe 方式へフォールバックする。
- 401 リカバリ: API が 401 を返したら、まず silent renew を 1 回試し (並行 401 は
  single-flight で renew 1 回に集約)、成功したら同一リクエストを新トークンで再送する。
  renew 失敗・再送も 401 の場合のみ対話ログインへ誘導する (再送は 1 回のみで無限ループしない)。

## マルチタブ

トークンを in-memory 保管にしたことで、各タブが独立に code flow を行い、同一 SSO セッションに
ぶら下がる別々の refresh token を持つ。renew はタブごとに独立し、共有ストレージの競合は発生しない。
前提として **refresh token rotation (`revokeRefreshToken`) は無効のまま** にすること
(Keycloak 既定)。rotation を有効にする場合は複数タブで renew が衝突するため
`refreshTokenMaxReuse` の緩和か BFF への移行が必要。

## ログアウト

`signoutRedirect` が Keycloak の `end_session_endpoint` へ遷移して SSO セッションを終了し、
`post_logout_redirect_uri` へ戻る。加えて `revokeTokensOnSignout: true` により、遷移前に
revocation endpoint で access/refresh token を失効させる。

## IdP (Keycloak / 本番) 側に必要な設定

- **refresh token の発行**: Authorization Code + PKCE の public client では Keycloak が既定で
  refresh token を返すため、realm への追加設定は不要 (`use.refresh.tokens` 既定 true)。
- **redirect URI**: `silent_redirect_uri` (`{origin}/silent-renew.html`) が client の
  `redirectUris` に含まれること。dev realm は `http://localhost:5173/*` で包含済み。
- **ライフタイム推奨値** (業務利用・8 時間勤務を想定):
  - Access Token Lifespan: 15 分 (現行 `accessTokenLifespan: 900`)
  - SSO Session Idle: 30 分以上 (renew 間隔 ≒ 14 分より十分長く。Keycloak 既定 30 分で可)
  - SSO Session Max: 10 時間程度 (勤務時間 + 余裕。超えたら対話再ログイン)
- **CSP との整合**: TLS 対応ブランチで導入する CSP に、silent サインインの iframe が IdP を
  読み込めるよう `frame-src <IdP origin>` (または `child-src` への追記) が必要。
  `connect-src` の IdP origin (token endpoint) は導入済みの `__CSP_CONNECT_SRC_EXTRA__` で対応する。
- **SSO Cookie**: iframe silent サインインは IdP の SSO Cookie がサードパーティ文脈で送られる
  必要がある。本番ではアプリと IdP を同一サイト (例: `app.example.com` と `auth.example.com`) に
  置くか、Cookie が `SameSite=None; Secure` であること (Keycloak は HTTPS 時に既定で対応)。
  ブラウザのサードパーティ Cookie 遮断で silent が失敗した場合はリダイレクトログインへ
  フォールバックするため、機能は損なわれない (UX が一往復分劣化するのみ)。
