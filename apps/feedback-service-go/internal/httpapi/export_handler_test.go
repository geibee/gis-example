package httpapi

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"testing"

	exportdomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/export"
)

func TestDecodeExportCreateDefaultsAndCanonicalHash(t *testing.T) {
	t.Parallel()
	body := []byte(`{
      "applicationKey":"inventory", "environmentKey":"prod",
      "externalWorkspaceKey":"main", "sessionId":null, "format":"csv"
    }`)
	command, err := decodeExportCreate(body, "1234567890abcdef")
	if err != nil {
		t.Fatal(err)
	}
	if command.Request.Locale != "ja-JP" || command.Request.Timezone != "Asia/Tokyo" ||
		command.Request.SessionID != nil || command.Request.Format != exportdomain.FormatCSV {
		t.Fatalf("export command = %+v", command)
	}
	if len(command.RequestHash) != 64 || command.IdempotencyKey != "1234567890abcdef" {
		t.Fatalf("export idempotency = %+v", command)
	}
}

func TestDecodeExportCreateRejectsInvalidShape(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		`null`, `[]`, `{}`,
		`{"applicationKey":"inventory","environmentKey":"prod","externalWorkspaceKey":"main","format":null}`,
		`{"applicationKey":"inventory","environmentKey":"prod","externalWorkspaceKey":"main","format":"csv","locale":null}`,
		`{"applicationKey":"inventory","environmentKey":"prod","externalWorkspaceKey":"main","format":"csv","unknown":true}`,
		`{"applicationKey":"inventory","environmentKey":"prod","externalWorkspaceKey":"main","format":"csv"} {}`,
	} {
		if _, err := decodeExportCreate([]byte(body), "1234567890abcdef"); err == nil {
			t.Fatalf("不正export bodyを受理しました: %s", body)
		}
	}
}

func TestMapExportError(t *testing.T) {
	t.Parallel()
	tests := []struct {
		kind   error
		status int
	}{
		{exportdomain.ErrInvalid, http.StatusBadRequest},
		{exportdomain.ErrStorageUnavailable, http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		mapped, ok := mapExportError(&exportdomain.Error{
			Kind: test.kind, Code: "export.test", Detail: "detail",
		}).(*APIError)
		if !ok || mapped.Status != test.status || mapped.Problem.Code != "export.test" {
			t.Fatalf("mapExportError(%v) = %#v", test.kind, mapped)
		}
	}
	if mapExportError(errors.New("unknown")) != nil {
		t.Fatal("未知errorは未写像にする必要があります")
	}
}

func TestStreamStoredExportRequiresExactObjectSize(t *testing.T) {
	t.Parallel()
	for name, fixture := range map[string]struct {
		body    string
		size    int64
		wantErr bool
	}{
		"exact": {body: "export", size: 6},
		"short": {body: "export", size: 7, wantErr: true},
		"long":  {body: "export", size: 5, wantErr: true},
	} {
		name, fixture := name, fixture
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			var output bytes.Buffer
			err := streamStoredExport(&output, exportdomain.Stored{
				Size: fixture.size, Body: io.NopCloser(bytes.NewBufferString(fixture.body)),
			})
			if (err != nil) != fixture.wantErr {
				t.Fatalf("streamStoredExport() output=%q error=%v", output.String(), err)
			}
		})
	}
}
