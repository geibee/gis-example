// レビュー通知専用ワーカー。API と同じイメージの bin/review-notification-worker から起動する。
package gis.example

import java.util.concurrent.CountDownLatch

fun main() {
    validateLogFormatEnv()
    val db = Database.fromEnv()
    db.migrateSchema()
    val sender = reviewNotificationSenderFromEnv()
    val worker = ReviewNotificationWorker(db, sender, ReviewNotificationWorkerSettings.fromEnv())
    Runtime.getRuntime().addShutdownHook(
        Thread {
            worker.stop()
            db.close()
        }
    )
    worker.start()
    CountDownLatch(1).await()
}
