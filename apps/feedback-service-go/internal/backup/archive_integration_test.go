package backup

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"

	serviceconfig "github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

func TestBackupArchiveWithMinIO(t *testing.T) {
	endpoint := os.Getenv("FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URL")
	if endpoint == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w3-export-backup" {
		t.Fatal("backup archive統合testはFEEDBACK_TEST_RUN_ID=w3-export-backupの専用runでのみ実行できます")
	}
	const bucket = "feedback-go-w3-export-backup"
	if configured := os.Getenv("FEEDBACK_GO_INTEGRATION_S3_BUCKET"); configured != bucket {
		t.Fatalf("backup archive統合testは専用bucket %qでのみ実行できます: %q", bucket, configured)
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	configuration, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(region), awsconfig.WithSharedConfigFiles([]string{}),
		awsconfig.WithSharedCredentialsFiles([]string{}),
	)
	if err != nil {
		t.Fatal(err)
	}
	client := s3.NewFromConfig(configuration, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(endpoint)
		options.UsePathStyle = true
	})
	if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)}); err != nil {
		if _, headErr := client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(bucket)}); headErr != nil {
			t.Fatalf("専用bucketを作成できません: create=%v head=%v", err, headErr)
		}
	}
	storage, err := objectstore.NewS3(ctx, serviceconfig.StorageSettings{
		Mode: serviceconfig.StorageModeS3, Bucket: bucket, EndpointURL: endpoint,
		Region: region, KeyPrefix: "w3-export-backup/",
	})
	if err != nil {
		t.Fatal(err)
	}
	prefix := "w3-export-backup/" + uuid.NewString() + "/"
	evidenceKey, archiveKey := prefix+"evidence.png", prefix+"archive.zip"
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_ = storage.Delete(cleanupCtx, evidenceKey)
		_ = storage.Delete(cleanupCtx, archiveKey)
	}()
	evidenceBytes := []byte("w3 minio evidence")
	if err := storage.Put(ctx, evidenceKey, "image/png", evidenceBytes); err != nil {
		t.Fatal(err)
	}
	value := "=formula"
	prepared := PreparedArchive{
		RunID: uuid.NewString(), Kind: KindFull, ScheduledFor: "2026-08-09T01:02:03Z",
		TenantKey: "tenant", ApplicationKey: "application", EnvironmentKey: "test",
		ExternalWorkspaceKey: "workspace", HistoryCoverageStartedAt: "2026-01-01T00:00:00Z",
		IncludeEvidence: true,
		CSVEntries:      []CSVEntry{{Path: "threads.csv", Header: []string{"value"}, Rows: [][]*string{{&value}}}},
		EvidenceEntries: []EvidenceEntry{{
			ArchivePath: "evidence/thread.png", ObjectKey: evidenceKey,
			ContentType: "image/png", ExpectedSHA256: SHA256Bytes(evidenceBytes),
		}},
	}
	path := filepath.Join(t.TempDir(), "backup.zip")
	result, err := WriteArchive(ctx, prepared, storage, path, func() time.Time {
		return time.Date(2026, 8, 9, 1, 3, 0, 0, time.UTC)
	})
	if err != nil || !VerifyArchive(path) {
		t.Fatalf("archive=%+v err=%v", result, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Put(ctx, archiveKey, "application/zip", data); err != nil {
		t.Fatal(err)
	}
	object, err := storage.Get(ctx, archiveKey)
	if err != nil {
		t.Fatal(err)
	}
	actual, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(actual, data) || SHA256Bytes(actual) != result.SHA256 {
		t.Fatalf("MinIO round-trip bytes=%d read=%v close=%v", len(actual), readErr, closeErr)
	}
}
