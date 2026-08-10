package httpapi

import (
	"errors"
	"net/http"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/discussion"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
)

func TestDecodeThreadCreateUsesStrictRawBase64(t *testing.T) {
	t.Parallel()
	handler := &APIHandler{discussionSettings: DiscussionAPISettings{EvidenceMaximumBytes: 1024}}
	valid := []byte(`{
      "location":{"schemaVersion":"1","pageKey":"home","routeTemplate":"/","pathParameters":{}},
      "target":{"schemaVersion":"1","kind":"screen-position","relativeX":0.5,"relativeY":0.25},
      "perspectiveCode":"ux","body":"本文","participantName":null,
      "evidence":{"contentType":"image/png","dataBase64":"iVBORw0KGgo=","viewportWidth":800,
        "viewportHeight":600,"pixelRatio":2,"capturedAt":"2026-08-09T12:34:56.123456789Z"}
    }`)
	request, err := handler.decodeThreadCreate(valid)
	if err != nil {
		t.Fatal(err)
	}
	if request.Evidence == nil || len(request.Evidence.Data) != 8 || request.ParticipantName != nil {
		t.Fatalf("thread request = %+v", request)
	}
	invalidWhitespace := []byte(`{
      "location":{},"target":{},"perspectiveCode":"ux","body":"本文",
      "evidence":{"contentType":"image/png","dataBase64":"iVBO\nRw0KGgo=","viewportWidth":800,
        "viewportHeight":600,"pixelRatio":2,"capturedAt":"2026-08-09T12:34:56Z"}
    }`)
	if _, err := handler.decodeThreadCreate(invalidWhitespace); !errors.Is(err, evidence.ErrInvalidInput) {
		t.Fatalf("whitespace base64 error = %v", err)
	}
}

func TestDiscussionDecodersRejectUnknownNullAndTrailingValues(t *testing.T) {
	t.Parallel()
	handler := &APIHandler{discussionSettings: DiscussionAPISettings{EvidenceMaximumBytes: 1024}}
	threadBodies := []string{
		`{"location":{},"target":{},"perspectiveCode":"ux","body":null}`,
		`{"location":{},"target":{},"perspectiveCode":"ux","body":"x","unknown":true}`,
		`{"location":{},"target":{},"perspectiveCode":"ux","body":"x"}{}`,
		`[]`,
	}
	for _, body := range threadBodies {
		if _, err := handler.decodeThreadCreate([]byte(body)); err == nil {
			t.Fatalf("不正thread bodyを受理しました: %s", body)
		}
	}
	for _, body := range []string{
		`{}`, `{"body":null}`, `{"body":"x","unknown":true}`, `[]`,
	} {
		if _, err := decodeMessageCreate([]byte(body)); err == nil {
			t.Fatalf("不正message bodyを受理しました: %s", body)
		}
	}
	for _, body := range []string{`{}`, `{"status":null}`, `{"status":"open","x":1}`, `[]`} {
		if _, err := decodeThreadStatusPatch([]byte(body)); err == nil {
			t.Fatalf("不正status patchを受理しました: %s", body)
		}
	}
}

func TestPhase2ErrorMappingAndRemoteHost(t *testing.T) {
	t.Parallel()
	rateError := &discussion.Error{
		Kind: discussion.ErrRateLimited, Code: "rate_limit.exceeded", Detail: "rate limit",
		RetryAfterSeconds: 60,
	}
	mapped, ok := mapPhase2Error(rateError).(*APIError)
	if !ok || mapped.Status != http.StatusTooManyRequests || mapped.Header.Get("Retry-After") != "60" {
		t.Fatalf("rate error mapping = %#v", mapped)
	}
	_, rangeError := evidence.PrepareHTTPDownload(evidence.Download{
		ContentType: "image/png", Data: []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a},
	}, stringPointer("bytes=99-100"))
	rangeMapped, ok := mapPhase2Error(rangeError).(*APIError)
	if !ok || rangeMapped.Status != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("range error mapping = %#v", rangeMapped)
	}
	if remoteHost("127.0.0.1:1234") != "127.0.0.1" || remoteHost("[::1]:4321") != "::1" || remoteHost("client") != "client" {
		t.Fatal("remote host normalizationが不正です")
	}
}

func stringPointer(value string) *string { return &value }
