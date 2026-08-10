// Package cryptoutil は通知・connector secretの暗号化と署名を提供する。
package cryptoutil

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
)

const KeySize = 32

// EncryptedValue はAES-256-GCMの暗号文とnonceである。
type EncryptedValue struct {
	Ciphertext []byte
	Nonce      []byte
}

// Cipher はcurrent keyで暗号化し、復号時はprevious keyへfallbackする。
// key rotation中も既存ciphertextを読み取れるようにするための型である。
type Cipher struct {
	current  []byte
	previous []byte
}

func NewCipher(current, previous []byte) (*Cipher, error) {
	if len(current) != KeySize {
		return nil, errors.New("current encryption keyは32 byte必要です")
	}
	if len(previous) != 0 && len(previous) != KeySize {
		return nil, errors.New("previous encryption keyは未設定または32 byte必要です")
	}
	return &Cipher{
		current:  append([]byte(nil), current...),
		previous: append([]byte(nil), previous...),
	}, nil
}

func (c *Cipher) Encrypt(plaintext []byte) (EncryptedValue, error) {
	block, err := aes.NewCipher(c.current)
	if err != nil {
		return EncryptedValue{}, fmt.Errorf("暗号化keyを初期化できません: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return EncryptedValue{}, fmt.Errorf("AES-GCMを初期化できません: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return EncryptedValue{}, fmt.Errorf("nonceを生成できません: %w", err)
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)
	return EncryptedValue{Ciphertext: ciphertext, Nonce: nonce}, nil
}

func (c *Cipher) EncryptString(plaintext string) (EncryptedValue, error) {
	return c.Encrypt([]byte(plaintext))
}

func (c *Cipher) Decrypt(ciphertext, nonce []byte) ([]byte, error) {
	plaintext, err := openGCM(c.current, ciphertext, nonce)
	if err == nil {
		return plaintext, nil
	}
	if len(c.previous) != 0 {
		if previous, previousErr := openGCM(c.previous, ciphertext, nonce); previousErr == nil {
			return previous, nil
		}
	}
	// 認証失敗や入力値を露出させない。
	return nil, errors.New("secretを復号できません")
}

func (c *Cipher) DecryptString(ciphertext, nonce []byte) (string, error) {
	plaintext, err := c.Decrypt(ciphertext, nonce)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func openGCM(key, ciphertext, nonce []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, errors.New("nonce lengthが不正です")
	}
	return gcm.Open(nil, nonce, ciphertext, nil)
}
