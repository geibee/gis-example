# Feedback SDK 固定アーティファクト

Web GIS が利用する Feedback SDK の固定npmアーティファクトを格納する。
編集可能な正本は `https://github.com/geibee/feedback-system` にあり、このディレクトリの
tarballを直接編集・再梱包してはならない。

現在の版は `1.0.0-alpha.1`。独立リポジトリのcommit `a3c7709` から `npm pack` した。

| ファイル | SHA-256 |
|---|---|
| `feedback-contracts-1.0.0-alpha.1.tgz` | `9c521930b8eb47e1957130e23351f6ecb1fb3e0798adc4cc6e7294b37d4304d1` |
| `feedback-core-1.0.0-alpha.1.tgz` | `cf9b90f6bd85ec562f9a44afb5a292a470edcd3de28f6abad4145bba3cbb48d9` |

npmレジストリへの公開後は、tarball依存を同一バージョンのregistry依存へ置き換える。
