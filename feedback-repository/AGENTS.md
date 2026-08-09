# 開発ガイド

- ドキュメント、コメント、コミットメッセージは日本語、コード識別子は英語で記述する。
- 公開契約は `contracts/feedback`、DB DDLはFeedback ServiceのFlyway migrationを正本とする。
- Feedback Serviceは通常PostgreSQLとprivate object storageだけを使用し、ホストDBを参照しない。
- 認証は直接OIDCまたは契約済みtoken exchange JWTに限定し、権限はDB membershipとtoken scopeの積集合にする。
- APIまたはDTOを変えたらOpenAPI、生成型、互換性文書を同じ変更で更新する。
- 設定を追加したら `docs/environment-variables.md` を更新し、secretに既定値を実装しない。
- 検証入口は `bash scripts/verify-feedback.sh`。未検証を成功として扱わない。
