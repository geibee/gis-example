package httpapi

import (
	"errors"
	"net/http"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/backup"
)

func TestDecodeBackupPolicyDefaultsAndNullableRetention(t *testing.T) {
	t.Parallel()
	policy, err := decodeBackupPolicy([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if policy.Enabled || policy.Timezone != "Asia/Tokyo" || policy.FullBackupAt != "02:00" ||
		policy.IncrementalIntervalMinutes != 60 || !policy.IncludeEvidence || policy.RetentionDays != nil {
		t.Fatalf("backup policy defaults = %+v", policy)
	}
	policy, err = decodeBackupPolicy([]byte(`{
      "enabled":true,"timezone":"UTC","fullBackupAt":"03:15",
      "incrementalIntervalMinutes":30,"includeEvidence":false,"retentionDays":90
    }`))
	if err != nil {
		t.Fatal(err)
	}
	if !policy.Enabled || policy.RetentionDays == nil || *policy.RetentionDays != 90 || policy.IncludeEvidence {
		t.Fatalf("backup policy = %+v", policy)
	}
	policy, err = decodeBackupPolicy([]byte(`{"retentionDays":null}`))
	if err != nil || policy.RetentionDays != nil {
		t.Fatalf("backup retention null = %+v err=%v", policy, err)
	}
}

func TestDecodeBackupPolicyRejectsInvalidShape(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		`null`, `[]`, `{"enabled":null}`, `{"timezone":null}`,
		`{"incrementalIntervalMinutes":1.5}`, `{"retentionDays":"90"}`,
		`{"unknown":true}`, `{} {}`,
	} {
		if _, err := decodeBackupPolicy([]byte(body)); err == nil {
			t.Fatalf("不正backup policyを受理しました: %s", body)
		}
	}
}

func TestMapBackupError(t *testing.T) {
	t.Parallel()
	tests := []struct {
		kind   error
		status int
	}{
		{backup.ErrInvalid, http.StatusBadRequest},
		{backup.ErrStorageUnavailable, http.StatusServiceUnavailable},
		{backup.ErrIntegrity, http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		mapped, ok := mapBackupError(&backup.Error{
			Kind: test.kind, Code: "backup.test", Detail: "detail",
		}).(*APIError)
		if !ok || mapped.Status != test.status || mapped.Problem.Code != "backup.test" {
			t.Fatalf("mapBackupError(%v) = %#v", test.kind, mapped)
		}
	}
	unknown := errors.New("unknown")
	if mapBackupError(unknown) != unknown {
		t.Fatal("未知errorは変更せず返す必要があります")
	}
}
