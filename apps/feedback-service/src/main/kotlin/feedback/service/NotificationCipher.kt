package feedback.service

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class EncryptedValue(val ciphertext: ByteArray, val nonce: ByteArray)

class NotificationCipher(
    currentKey: ByteArray,
    previousKey: ByteArray? = null,
    private val secureRandom: SecureRandom = SecureRandom()
) {
    private val encryptionKey = validateKey(currentKey)
    private val decryptionKeys = listOfNotNull(encryptionKey, previousKey?.let(::validateKey))

    fun encrypt(value: String): EncryptedValue {
        val nonce = ByteArray(12).also(secureRandom::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(encryptionKey, "AES"), GCMParameterSpec(128, nonce))
        return EncryptedValue(cipher.doFinal(value.toByteArray()), nonce)
    }

    fun decrypt(ciphertext: ByteArray, nonce: ByteArray): String {
        require(nonce.size == 12) { "notification endpoint nonce が不正です" }
        decryptionKeys.forEach { key ->
            val plaintext = runCatching {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
                cipher.doFinal(ciphertext).decodeToString()
            }.getOrNull()
            if (plaintext != null) return plaintext
        }
        error("notification endpoint を復号できません。暗号鍵の rotation 設定を確認してください")
    }

    companion object {
        fun fromEnv(): NotificationCipher {
            val current = decodeKey(requiredEnv("FEEDBACK_NOTIFICATION_ENCRYPTION_KEY"), "FEEDBACK_NOTIFICATION_ENCRYPTION_KEY")
            val previous = System.getenv("FEEDBACK_NOTIFICATION_ENCRYPTION_KEY_PREVIOUS")
                ?.takeIf { it.isNotBlank() }
                ?.let { decodeKey(it, "FEEDBACK_NOTIFICATION_ENCRYPTION_KEY_PREVIOUS") }
            return NotificationCipher(current, previous)
        }

        private fun decodeKey(value: String, name: String): ByteArray = try {
            Base64.getDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            error("$name は base64 で指定してください")
        }

        private fun validateKey(value: ByteArray): ByteArray = value.copyOf().also {
            require(it.size == 32) { "notification encryption key は 32 byte 必須です" }
        }
    }
}
