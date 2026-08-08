package feedback.service

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class NotificationCipherTest {
    @Test
    fun `AES-GCM で暗号化して復号できる`() {
        val cipher = NotificationCipher(ByteArray(32) { 1 })
        val plaintext = "https://hooks.example.test/feedback"

        val encrypted = cipher.encrypt(plaintext)

        assertEquals(12, encrypted.nonce.size)
        assertEquals(plaintext, cipher.decrypt(encrypted.ciphertext, encrypted.nonce))
        assertFailsWith<IllegalStateException> {
            cipher.decrypt(encrypted.ciphertext.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }, encrypted.nonce)
        }
    }

    @Test
    fun `旧鍵で保存された値をローテーション中に復号できる`() {
        val oldKey = ByteArray(32) { 2 }
        val newKey = ByteArray(32) { 3 }
        val encryptedWithOldKey = NotificationCipher(oldKey).encrypt("https://hooks.example.test/old")
        val rotatedCipher = NotificationCipher(newKey, oldKey)

        assertEquals(
            "https://hooks.example.test/old",
            rotatedCipher.decrypt(encryptedWithOldKey.ciphertext, encryptedWithOldKey.nonce)
        )

        val encryptedWithNewKey = rotatedCipher.encrypt("https://hooks.example.test/new")
        assertContentEquals(
            "https://hooks.example.test/new".encodeToByteArray(),
            NotificationCipher(newKey).decrypt(encryptedWithNewKey.ciphertext, encryptedWithNewKey.nonce).encodeToByteArray()
        )
    }

    @Test
    fun `暗号鍵は32 byteだけを受け付ける`() {
        assertFailsWith<IllegalArgumentException> { NotificationCipher(ByteArray(31)) }
    }
}
