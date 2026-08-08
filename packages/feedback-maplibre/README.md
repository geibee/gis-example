# @feedback/maplibre

MapLibre featureを製品横断の安定した `sourceKey` / `featureKey` へ変換し、地図pinの lifecycle を管理する
任意 package です。`maplibre-gl` はこの package だけの peer dependency で、`@feedback/react` の導入には
不要です。

`bindMapLibreFeedbackPins` は style reload でmarkerを再構築し、required layer消滅時とmap unload時に
markerを破棄します。

地図canvasを証跡へ含めるための `preserveDrawingBuffer` は描画性能とmemory消費に影響します。既定で有効に
せず、必要なホストだけが選択してください。代替として `FeedbackHostAdapter.captureEvidence` に地図サービスの
snapshot等を使う capture provider を指定できます。
