package discussion

import (
	"encoding/base64"
	"strconv"
	"strings"
)

func EncodeCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte("offset:" + strconv.Itoa(offset)))
}

func DecodeCursor(cursor *string) (int, error) {
	if cursor == nil {
		return 0, nil
	}
	if len(*cursor) > 2000 {
		return 0, invalid("request.invalid", "cursorが長すぎます")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(*cursor)
	if err != nil {
		return 0, invalid("request.invalid", "cursorが不正です")
	}
	value := string(decoded)
	if !strings.HasPrefix(value, "offset:") {
		return 0, invalid("request.invalid", "cursorが不正です")
	}
	offset, err := strconv.Atoi(strings.TrimPrefix(value, "offset:"))
	if err != nil || offset < 0 {
		return 0, invalid("request.invalid", "cursorが不正です")
	}
	return offset, nil
}
