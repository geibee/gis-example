package objectstore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"

	serviceconfig "github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
)

func TestValidateKey(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		key   string
		valid bool
	}{
		{name: "nested", key: "evidence/tenant/workspace/thread", valid: true},
		{name: "empty", key: ""},
		{name: "absolute", key: "/etc/passwd"},
		{name: "parent", key: "evidence/../secret"},
		{name: "current", key: "evidence/./secret"},
		{name: "empty segment", key: "evidence//secret"},
		{name: "trailing slash", key: "evidence/"},
		{name: "backslash", key: `evidence\secret`},
		{name: "nul", key: "evidence/\x00secret"},
		{name: "invalid utf8", key: string([]byte{0xff})},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := ValidateKey(test.key)
			if (err == nil) != test.valid {
				t.Fatalf("ValidateKey(%q) error = %v, valid=%v", test.key, err, test.valid)
			}
			if err != nil && !errors.Is(err, ErrInvalidKey) {
				t.Fatalf("error = %v, want ErrInvalidKey", err)
			}
		})
	}
}

func TestLocalObjectLifecycle(t *testing.T) {
	t.Parallel()
	storage, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := "evidence/tenant/workspace/thread"
	data := []byte("payload")
	if err := storage.Put(ctx, key, "image/png", data); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if err := storage.Put(ctx, key, "image/png", []byte("replacement")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second Put() error = %v, want ErrAlreadyExists", err)
	}
	object, err := storage.Get(ctx, key)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	actual, err := io.ReadAll(object.Body)
	if closeErr := object.Body.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		t.Fatalf("object body error = %v", err)
	}
	if object.Key != key || object.Size != int64(len(data)) || !reflect.DeepEqual(actual, data) || object.LastModified.IsZero() {
		t.Fatalf("object = %+v", object)
	}
	refs, err := storage.List(ctx, "evidence/")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(refs) != 1 || refs[0].Key != key {
		t.Fatalf("refs = %+v", refs)
	}
	if err := storage.Delete(ctx, key); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if err := storage.Delete(ctx, key); err != nil {
		t.Fatalf("idempotent Delete() error = %v", err)
	}
	if _, err := storage.Get(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(deleted) error = %v, want ErrNotFound", err)
	}
}

func TestLocalRejectsTraversalThroughSymlink(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlinkを作成できません: %v", err)
	}
	storage, err := NewLocal(root)
	if err != nil {
		t.Fatal(err)
	}
	err = storage.Put(context.Background(), "escape/object", "image/png", []byte("secret"))
	if err == nil {
		t.Fatal("root外symlinkへのPutが成功しました")
	}
	if _, statErr := os.Stat(filepath.Join(outside, "object")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("root外へfileが作成されました: %v", statErr)
	}
}

func TestLocalHonorsCanceledContext(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	storage, err := NewLocal(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := storage.Put(ctx, "evidence/object", "image/png", []byte("payload")); !errors.Is(err, context.Canceled) {
		t.Fatalf("Put() error = %v, want context.Canceled", err)
	}
	if _, err := os.Stat(filepath.Join(root, "evidence", "object")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancel後にobjectが残りました: %v", err)
	}
}

func TestLocalPutReaderRequiresExactSizeAndRemovesPartial(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	storage, err := NewLocal(root)
	if err != nil {
		t.Fatal(err)
	}
	for name, fixture := range map[string]struct {
		body string
		size int64
	}{
		"short": {body: "abc", size: 4},
		"long":  {body: "abcd", size: 3},
	} {
		name, fixture := name, fixture
		t.Run(name, func(t *testing.T) {
			key := "stream/" + name
			if err := storage.PutReader(
				context.Background(), key, "application/octet-stream",
				strings.NewReader(fixture.body), fixture.size,
			); err == nil {
				t.Fatal("size不一致readerを受理しました")
			}
			if _, err := os.Stat(filepath.Join(root, "stream", name)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("size不一致objectが残りました: %v", err)
			}
		})
	}
}

func TestLocalListMissingPrefix(t *testing.T) {
	t.Parallel()
	storage, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	refs, err := storage.List(context.Background(), "missing/")
	if err != nil || len(refs) != 0 {
		t.Fatalf("List() refs=%v error=%v", refs, err)
	}
}

func TestS3ObjectLifecycle(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "test-access-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test-secret-key")
	t.Setenv("AWS_REGION", "ap-northeast-1")
	const key = "evidence/tenant/workspace/thread"
	payload := []byte("payload")
	var mu sync.Mutex
	requests := make([]string, 0, 4)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		requests = append(requests, request.Method+" "+request.URL.Path+"?"+request.URL.RawQuery)
		mu.Unlock()
		switch {
		case request.Method == http.MethodPut && request.URL.Path == "/bucket/"+key:
			if request.Header.Get("If-None-Match") != "*" || request.Header.Get("Content-Type") != "image/png" {
				t.Errorf("PUT headers=%v", request.Header)
			}
			body, _ := io.ReadAll(request.Body)
			if !reflect.DeepEqual(body, payload) {
				t.Errorf("PUT body=%q", body)
			}
			writer.WriteHeader(http.StatusOK)
		case request.Method == http.MethodGet && request.URL.Path == "/bucket/"+key:
			writer.Header().Set("Content-Type", "image/png")
			writer.Header().Set("Last-Modified", "Sun, 09 Aug 2026 12:00:00 GMT")
			writer.Header().Set("Content-Length", "7")
			_, _ = writer.Write(payload)
		case request.Method == http.MethodDelete && request.URL.Path == "/bucket/"+key:
			writer.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodGet && request.URL.Path == "/bucket" && request.URL.Query().Get("list-type") == "2":
			writer.Header().Set("Content-Type", "application/xml")
			_, _ = writer.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><IsTruncated>false</IsTruncated>
<Contents><Key>` + key + `</Key><LastModified>2026-08-09T12:00:00Z</LastModified><Size>7</Size></Contents></ListBucketResult>`))
		default:
			http.Error(writer, "unexpected request", http.StatusBadRequest)
		}
	}))
	defer server.Close()
	storage, err := NewS3(context.Background(), serviceconfig.StorageSettings{
		Mode: serviceconfig.StorageModeS3, Bucket: "bucket", EndpointURL: server.URL, KeyPrefix: "evidence/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.PutReader(
		context.Background(), key, "image/png", bytes.NewReader(payload), int64(len(payload)),
	); err != nil {
		t.Fatalf("PutReader() error=%v", err)
	}
	object, err := storage.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("Get() error=%v", err)
	}
	got, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || object.ContentType != "image/png" || object.Size != 7 || !bytes.Equal(got, payload) {
		t.Fatalf("object=%+v body=%q readErr=%v closeErr=%v", object, got, readErr, closeErr)
	}
	refs, err := storage.List(context.Background(), "evidence/")
	if err != nil || len(refs) != 1 || refs[0].Key != key {
		t.Fatalf("List() refs=%+v error=%v", refs, err)
	}
	if err := storage.Delete(context.Background(), key); err != nil {
		t.Fatalf("Delete() error=%v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 4 || !strings.Contains(requests[2], "prefix=evidence%2F") {
		t.Fatalf("requests=%v", requests)
	}
}

func TestS3ObjectLifecycleWithMinIO(t *testing.T) {
	endpoint := os.Getenv("FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URL")
	if endpoint == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w2-evidence" {
		t.Fatal("MinIO統合testはFEEDBACK_TEST_RUN_ID=w2-evidenceの専用bucketでのみ実行できます")
	}
	bucket := os.Getenv("FEEDBACK_GO_INTEGRATION_S3_BUCKET")
	if bucket == "" {
		t.Fatal("FEEDBACK_GO_INTEGRATION_S3_BUCKETが未設定です")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}
	storage, err := NewS3(ctx, serviceconfig.StorageSettings{
		Mode: serviceconfig.StorageModeS3, Bucket: bucket, EndpointURL: endpoint,
		Region: region, KeyPrefix: "w2-evidence/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("FEEDBACK_GO_INTEGRATION_S3_CREATE_BUCKET") == "1" {
		const dedicatedBucket = "feedback-go-w2-evidence"
		if bucket != dedicatedBucket {
			t.Fatalf("bucket自動作成は専用bucket %q に限定します", dedicatedBucket)
		}
		_, createErr := storage.client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: &bucket})
		if createErr != nil && !isS3Status(createErr, http.StatusConflict) {
			t.Fatalf("専用bucketを作成できません: %v", createErr)
		}
	}
	key := "w2-evidence/" + uuid.NewString()
	data := []byte("w2-evidence-minio")
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_ = storage.Delete(cleanupCtx, key)
	}()
	if err := storage.PutReader(ctx, key, "image/png", bytes.NewReader(data), int64(len(data))); err != nil {
		t.Fatal(err)
	}
	object, err := storage.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if err != nil || closeErr != nil || !bytes.Equal(actual, data) || object.ContentType != "image/png" {
		t.Fatalf("object=%+v body=%q readErr=%v closeErr=%v", object, actual, err, closeErr)
	}
	refs, err := storage.List(ctx, "w2-evidence/")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ref := range refs {
		found = found || ref.Key == key
	}
	if !found {
		t.Fatalf("作成したobjectがListにありません: %s", key)
	}
	if err := storage.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
}

func TestS3ObjectInteroperabilityWithKotlin(t *testing.T) {
	phase := os.Getenv("FEEDBACK_GO_INTEGRATION_S3_INTEROP_PHASE")
	if phase == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_S3_INTEROP_PHASEが未設定です")
	}
	if phase != "write" && phase != "read-cleanup" {
		t.Fatalf("未対応の相互運用phaseです: %s", phase)
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w2-interop" {
		t.Fatal("相互運用testはFEEDBACK_TEST_RUN_ID=w2-interopでのみ実行できます")
	}
	endpoint := os.Getenv("FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URL")
	if endpoint == "" {
		t.Fatal("FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URLが未設定です")
	}
	const bucket = "feedback-go-w2-evidence"
	if actual := os.Getenv("FEEDBACK_GO_INTEGRATION_S3_BUCKET"); actual != bucket {
		t.Fatalf("相互運用testは専用bucket %qでのみ実行できます: %q", bucket, actual)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}
	storage, err := NewS3(ctx, serviceconfig.StorageSettings{
		Mode: serviceconfig.StorageModeS3, Bucket: bucket, EndpointURL: endpoint,
		Region: region, KeyPrefix: "w2-interop/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if phase == "write" {
		_, createErr := storage.client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)})
		if createErr != nil && !isS3Status(createErr, http.StatusConflict) {
			t.Fatalf("専用bucketを作成できません: %v", createErr)
		}
		const key = "w2-interop/go-object"
		if err := storage.Delete(ctx, key); err != nil {
			t.Fatal(err)
		}
		if err := storage.Put(ctx, key, "application/octet-stream", []byte("written-by-go-v1\n")); err != nil {
			t.Fatal(err)
		}
		return
	}

	keys := map[string][]byte{
		"w2-interop/go-object":     []byte("written-by-go-v1\n"),
		"w2-interop/kotlin-object": []byte("written-by-kotlin-v1\n"),
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		for key := range keys {
			_ = storage.Delete(cleanupCtx, key)
		}
	}()
	for key, expected := range keys {
		object, getErr := storage.Get(ctx, key)
		if getErr != nil {
			t.Fatalf("%sをGoから読めません: %v", key, getErr)
		}
		actual, readErr := io.ReadAll(object.Body)
		closeErr := object.Body.Close()
		if readErr != nil || closeErr != nil || !bytes.Equal(actual, expected) {
			t.Fatalf("%sの内容が一致しません: body=%q read=%v close=%v", key, actual, readErr, closeErr)
		}
	}
}
