// リバースプロキシ (CloudFront/ALB 等) 背後での X-Forwarded-* ヘッダの解釈。
// TLS 終端はクラウド側 (CloudFront + ALB + ACM) の責務であり、API は HTTP で受けるため、
// scheme (https 判定)・クライアント IP・Host をプロキシが付与したヘッダから復元する必要がある。
//
// セキュリティ上の注意 (信頼境界):
// - X-Forwarded-* はクライアントが自由に詐称できるため、「信頼できるプロキシの背後にいる」
//   ことが確実な場合のみ有効化する。API を直接公開する構成では必ず 0 (無効) のままにする
// - trustedProxyCount は「自分の手前にいる、ヘッダへ追記する信頼できるプロキシの段数」。
//   例: ALB のみ = 1、CloudFront + ALB = 2。
//   X-Forwarded-For は各プロキシが「自分から見た接続元」を末尾に追記していくため、
//   信頼できる段数 N のとき末尾から N 番目がクライアント IP になる (それより先頭側は詐称可能)
//
// 段数の数え方・本番構成の全体像は docs/reverse-proxy.md を参照
package gis.example

import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.forwardedheaders.XForwardedHeaders

fun Application.installForwardedHeadersSupport(trustedProxyCount: Int) {
    require(trustedProxyCount >= 0) { "TRUSTED_PROXY_COUNT は 0 以上を指定してください: $trustedProxyCount" }
    // 0 = プラグイン自体を入れない (直接公開時にクライアント由来の X-Forwarded-* を信頼しない)
    if (trustedProxyCount == 0) return
    install(XForwardedHeaders) {
        if (trustedProxyCount == 1) {
            useLastProxy()
        } else {
            // 末尾 (最も近いプロキシ側) から trustedProxyCount - 1 個を読み飛ばし、
            // 信頼できる最遠のプロキシが記録した接続元をクライアントとして採用する
            skipLastProxies(trustedProxyCount - 1)
        }
    }
}
