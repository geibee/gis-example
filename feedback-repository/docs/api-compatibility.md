# API互換性

`/feedback/v1` と `@feedback/*` 1.xの公開APIは後方互換を維持する。React以外の公式境界は
`@feedback/core`、OpenAPI、JSON Schema。MapLibreとAdmin UIは任意packageである。

registry公開前は `npm pack` のtarballをcleanなReact 18/19 + Vite consumerへinstallして検証する。
公開時は同じpackage versionとService image tagをnpm互換registry/OCI registryへ配置する。
