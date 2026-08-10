package cryptoutil

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// SignTimestamp はConnector Protocol v1のtimestamp.rawBody署名を返す。
func SignTimestamp(secret []byte, timestamp int64, rawBody []byte) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(strconv.FormatInt(timestamp, 10)))
	_, _ = mac.Write([]byte{'.'})
	_, _ = mac.Write(rawBody)
	return "v1=" + hex.EncodeToString(mac.Sum(nil))
}

// VerifyTimestampSignature は時刻窓と署名をconstant-timeで検証する。
func VerifyTimestampSignature(
	secret []byte,
	timestampRaw, signature string,
	rawBody []byte,
	now time.Time,
	maximumSkew time.Duration,
) bool {
	timestamp, err := strconv.ParseInt(timestampRaw, 10, 64)
	if err != nil || maximumSkew < 0 {
		return false
	}
	delta := now.Unix() - timestamp
	if delta < 0 {
		delta = -delta
	}
	if delta > int64(maximumSkew/time.Second) {
		return false
	}
	want := strings.TrimPrefix(SignTimestamp(secret, timestamp, rawBody), "v1=")
	candidate := strings.TrimPrefix(signature, "v1=")
	if len(candidate) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(candidate), []byte(want)) == 1
}

// MaskSecret はsecretを応答・logへ載せないための固定maskを返す。
func MaskSecret(value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	return "********"
}
