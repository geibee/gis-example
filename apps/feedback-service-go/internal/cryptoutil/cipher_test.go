package cryptoutil

import (
	"bytes"
	"testing"
	"time"
)

func TestCipherRotationAndTamper(t *testing.T) {
	oldKey := bytes.Repeat([]byte{1}, KeySize)
	newKey := bytes.Repeat([]byte{2}, KeySize)
	oldCipher, err := NewCipher(oldKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := oldCipher.EncryptString("secret-value")
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := NewCipher(newKey, oldKey)
	if err != nil {
		t.Fatal(err)
	}
	got, err := rotated.DecryptString(encrypted.Ciphertext, encrypted.Nonce)
	if err != nil || got != "secret-value" {
		t.Fatalf("rotation decrypt = %q, %v", got, err)
	}
	encrypted.Ciphertext[0] ^= 1
	if _, err := rotated.Decrypt(encrypted.Ciphertext, encrypted.Nonce); err == nil {
		t.Fatal("改ざんしたciphertextを復号しました")
	}
}

func TestVerifyTimestampSignature(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	body := []byte(`{"ok":true}`)
	signature := SignTimestamp([]byte("a sufficiently long shared secret"), now.Unix(), body)
	if !VerifyTimestampSignature([]byte("a sufficiently long shared secret"), "1700000000", signature, body, now, 5*time.Minute) {
		t.Fatal("正しい署名を拒否しました")
	}
	if VerifyTimestampSignature([]byte("a sufficiently long shared secret"), "1699999699", signature, body, now, 5*time.Minute) {
		t.Fatal("時刻窓外の署名を許可しました")
	}
}

func TestMaskSecret(t *testing.T) {
	t.Parallel()
	if MaskSecret("") != "" || MaskSecret("top-secret") != "********" ||
		bytes.Contains([]byte(MaskSecret("top-secret")), []byte("secret")) {
		t.Fatal("secret maskが値を露出しました")
	}
}
