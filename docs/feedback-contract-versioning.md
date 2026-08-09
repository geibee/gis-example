# Feedback 契約・package バージョニング

Feedback API と SDK package は SemVer を使い、API major は URL (`/feedback/v1`) に固定する。
`@feedback/contracts`、`@feedback/core`、`@feedback/react`、`@feedback/maplibre` は同じ major を持つが、
同時 release を必須にはしない。

- breaking change は新しい API major path と package major で行う。
- API は少なくとも 1 つ前の SDK minor をサポートする。
- additive な target/manifest schema は `/capabilities` で交渉し、未対応 SDK へ送らない。
- `@feedback/core` は起動時に API major、manifest schema、target schema を検査し、不一致時は
  feedback UI だけを unavailable にする。
- write は `Idempotency-Key`、更新は `ETag` / `If-Match` を契約とする。
- prerelease は restricted registry へ `alpha` / `beta` dist-tag で公開し、互換 consumer test を通してから
  `latest` へ昇格する。

現行 `@web-gis/feedback-plugin` は Web GIS API 用の互換 package であり、v1 package の一部ではない。
Phase 4 完了後に deprecated とし、旧 API のサポート期限と移行手順を changelog で告知する。
