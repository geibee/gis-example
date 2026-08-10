package postgres

import (
	"strings"
	"testing"
)

func TestSanitizeBackupAuditChangesMatchesKotlinRules(t *testing.T) {
	t.Parallel()
	values := make([]any, 51)
	for index := range values {
		values[index] = index
	}
	actual := sanitizeBackupAuditElement(map[string]any{
		"safe": "value", "evidence": int64(2), "nested": map[string]any{"accessToken": "secret"},
		"long": strings.Repeat("あ", 1001), "array": values,
	}, "").(map[string]any)
	if actual["evidence"] != "[REDACTED]" || actual["safe"] != "value" {
		t.Fatalf("sensitive=%+v", actual)
	}
	if actual["nested"].(map[string]any)["accessToken"] != "[REDACTED]" {
		t.Fatalf("nested=%+v", actual["nested"])
	}
	if !strings.HasPrefix(actual["long"].(string), "[SUMMARY:length=1001,sha256=") {
		t.Fatalf("long=%v", actual["long"])
	}
	array := actual["array"].([]any)
	if len(array) != 51 || array[50] != "[TRUNCATED:51]" {
		t.Fatalf("array=%+v", array)
	}
}

func TestTruncateUTF16DoesNotSplitMultibyteText(t *testing.T) {
	t.Parallel()
	actual := truncateUTF16(strings.Repeat("あ", 1999)+"😀tail", 2000)
	if actual != strings.Repeat("あ", 1999) {
		t.Fatalf("UTF-16境界が不一致です: units=%d", len([]rune(actual)))
	}
}
