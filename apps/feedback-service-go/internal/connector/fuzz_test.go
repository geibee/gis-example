package connector

import "testing"

func FuzzNotificationText(f *testing.F) {
	for _, seed := range []string{
		`{"eventType":"feedback.message.created.v1","actor":{"displayName":"担当"},"body":"本文","deepLink":"https://example.test"}`,
		`null`, `{}`, `{"eventType":1}`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		first, err := NotificationText(raw)
		if err != nil {
			return
		}
		second, err := NotificationText(raw)
		if err != nil || first != second {
			t.Fatalf("connector通知textが安定していません: first=%q second=%q err=%v", first, second, err)
		}
	})
}
