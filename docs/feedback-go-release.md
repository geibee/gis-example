# Feedback Service Go release artifact

Go版のrelease候補は、空directoryを指定して次のcommandで生成する。

```bash
bash scripts/build-feedback-go-release.sh --output /tmp/feedback-go-release --version 1.0.0-rc.1
```

出力にはserver用linux/amd64・linux/arm64静的binary、CLI/ローカル検証用darwin/arm64・windows/amd64 binary、
両Linux platformを含むOCI archive、linux/amd64・linux/arm64別のCycloneDX SBOM、
HIGH/CRITICALでfailするplatform別OCI vulnerability scanのSARIF、`release-manifest.json`、`SHA256SUMS` が含まれる。
署名・registry pushはこのcommandでは行わず、
外部状態を変更しないrelease buildとする。publish時は `release-manifest.json` と `SHA256SUMS` を
署名対象にし、OCI registryへpushしたdigestもrelease記録へ追加する。

runtime stageはUID/GID 65532のdistroless static imageで、shellとpackage managerを含めない。10 entrypointのsymlinkは
build stageで生成し、最終imageには静的binary、CA証明書、timezone dataと書込み用data directoryだけを追加する。

darwin/windows artifactはsymlink名ではなくsubcommandでCLIを選ぶ。例えばmacOSは
`./feedback-service-go_<version>_darwin_arm64 backup-pull`、Windowsは
`feedback-service-go_<version>_windows_amd64.exe legacy-migration ...` とする。serverの本番保証対象はLinuxだけである。

独立repositoryはGo-only形状だけを空directoryへ組み立てる。

```bash
scripts/assemble-feedback-repository --output /tmp/feedback-go-only --go-only
bash scripts/check-feedback-go-only-extraction.sh
```

Go-only候補はKotlin/JDK/Gradleを含まず、空DB用clean V1をGo binaryへ埋め込む。過去の稼働済みKotlin環境を
in-place移行する場合だけ、切替元digestをartifact retention policyで別途保持する。

生成にはGo 1.26.5、Docker Buildx、Trivy 0.70.0、jqが必要である。nightlyは同じcommandを実行し、
成果物を14日間保存する。

## 初回導入候補の結果

2026-08-10にbaseline内包後の`1.0.0-rc.1`を
`ci-results/feedback-go-release-final-go-only-20260810`へ生成した。`SHA256SUMS`は全件一致し、platform別Trivy SARIFは
linux/amd64・linux/arm64とも結果0件だった。Linux binaryはamd64 30,044,322 bytes、arm64 27,525,282 bytesである。
空DB用baselineのSHA-256は`f5dba8092f63dcf0b49378582a1a6be3d32e5f6577a6e6e1ec131a811850e0cd`で固定する。

この候補より前に生成した`ci-results/feedback-go-release-rejected-kin-openapi-v0142-20260810`は、Trivyが
`kin-openapi v0.142.0`のCriticalを検出したためrejectした証跡であり、配布しない。
