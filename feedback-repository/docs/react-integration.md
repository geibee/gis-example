# React組み込み

React 18/19では `@feedback/core` のHostAdapterとtransportを作成し、`@feedback/react` の
`FeedbackProvider` / `FeedbackErrorBoundary` / `FeedbackOverlay` を業務画面の一部へ配置する。
SDK全体でrouter、認証、workspace解決を所有せず、HostAdapterから受け取る。

Service障害時はErrorBoundaryと `FeedbackUnavailable` がFeedback subtreeだけを縮退させる。
業務画面の描画やナビゲーションをtoken取得の完了へ依存させない。MapLibreを使う場合だけ
`@feedback/maplibre` を追加する。他フレームワークは `@feedback/core` とHTTP契約を利用する。
