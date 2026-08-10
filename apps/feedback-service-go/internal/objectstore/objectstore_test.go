package objectstore

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	serviceconfig "github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
)

func TestLocalReadinessCreatesAndChecksDirectory(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "nested", "objects")
	storage, err := NewLocal(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.CheckReadiness(context.Background()); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Fatalf("root stat=%+v err=%v", info, err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := storage.CheckReadiness(canceled); err == nil {
		t.Fatal("cancel済みcontextでreadinessが成功しました")
	}
}

func TestS3ReadinessListsConfiguredPrefix(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "test-access-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test-secret-key")
	t.Setenv("AWS_REGION", "ap-northeast-1")
	var requestPath, requestQuery string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestPath = request.URL.Path
		requestQuery = request.URL.RawQuery
		writer.Header().Set("Content-Type", "application/xml")
		_, _ = writer.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bucket</Name></ListBucketResult>`))
	}))
	defer server.Close()

	storage, err := NewS3(context.Background(), serviceconfig.StorageSettings{
		Mode: serviceconfig.StorageModeS3, Bucket: "bucket", EndpointURL: server.URL,
		KeyPrefix: "evidence/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.CheckReadiness(context.Background()); err != nil {
		t.Fatal(err)
	}
	if requestPath != "/bucket" || !strings.Contains(requestQuery, "prefix=evidence%2F") ||
		!strings.Contains(requestQuery, "list-type=2") {
		t.Fatalf("path=%q query=%q", requestPath, requestQuery)
	}
}

func TestS3ReadinessFailsClosed(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "test-access-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test-secret-key")
	t.Setenv("AWS_REGION", "ap-northeast-1")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "denied", http.StatusForbidden)
	}))
	defer server.Close()
	storage, err := NewS3(context.Background(), serviceconfig.StorageSettings{
		Mode: serviceconfig.StorageModeS3, Bucket: "bucket", EndpointURL: server.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.CheckReadiness(context.Background()); err == nil {
		t.Fatal("S3障害時にreadinessが成功しました")
	}
}
