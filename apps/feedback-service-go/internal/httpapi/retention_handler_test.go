package httpapi

import (
	"errors"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/retention"
)

func TestDecodeRetentionPolicy(t *testing.T) {
	t.Parallel()
	policy, err := decodeRetentionPolicy([]byte(`{"evidenceRetentionDays":null}`))
	if err != nil || policy.EvidenceRetentionDays != nil || policy.ExportRetentionDays != 7 {
		t.Fatalf("default policy = %+v, error=%v", policy, err)
	}
	policy, err = decodeRetentionPolicy([]byte(`{"evidenceRetentionDays":30,"exportRetentionDays":14}`))
	if err != nil || policy.EvidenceRetentionDays == nil || *policy.EvidenceRetentionDays != 30 ||
		policy.ExportRetentionDays != 14 {
		t.Fatalf("explicit policy = %+v, error=%v", policy, err)
	}
}

func TestDecodeRetentionPolicyRejectsContractViolations(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		`{}`, `{"exportRetentionDays":7}`, `{"evidenceRetentionDays":"30"}`,
		`{"evidenceRetentionDays":null,"extra":true}`,
	} {
		if _, err := decodeRetentionPolicy([]byte(body)); err == nil {
			t.Fatalf("invalid body accepted: %s", body)
		}
	}
}

func TestMapRetentionError(t *testing.T) {
	t.Parallel()
	mapped := mapRetentionError(&retention.Error{
		Kind: retention.ErrInvalid, Code: "request.invalid", Detail: "invalid",
	})
	var apiError *APIError
	if !errors.As(mapped, &apiError) || apiError.Status != 400 {
		t.Fatalf("mapped error = %#v", mapped)
	}
}
