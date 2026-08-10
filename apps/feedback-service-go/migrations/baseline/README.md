# Fresh baseline

monorepoではV1〜V6のDDLをKotlin/Flywayが所有するため、このdirectoryへSQLを手編集しない。
`assemble-feedback-repository` がV1〜V6収束済みのclean V1を抽出先だけへ生成し、Go-only fresh installで埋め込む。

Go-only抽出物の`feedback-migrate`だけが、完全な空DBへこのSQLをtransaction適用する。FlywayとGoのclean V1はassembly時に
byte一致を確認し、埋め込みSQLのSHA-256、Flyway互換CRC32、fresh schema fingerprintが不正なら適用前に拒否する。
