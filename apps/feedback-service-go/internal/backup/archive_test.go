package backup

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

func TestRenderArchiveCSVMatchesKotlinFixture(t *testing.T) {
	t.Parallel()
	unsafe := `=HYPERLINK("bad")`
	actual := RenderArchiveCSV(
		[]string{"thread_id", "body", "nullable"},
		[][]*string{{backupString("thread-1"), &unsafe, nil}},
	)
	want := "\ufeff\"thread_id\",\"body\",\"nullable\"\r\n" +
		"\"thread-1\",\"'=HYPERLINK(\"\"bad\"\")\",\"\"\r\n"
	if string(actual) != want {
		t.Fatalf("archive CSV mismatch\nactual=%q\nwant  =%q", actual, want)
	}
	if got := SHA256Bytes(actual); got != "453932880324f6e16ba43f7acd0963437c8e1f25b5e3962d4300da18b0402bfa" {
		t.Fatalf("Kotlin fixture CSV SHA-256 = %s", got)
	}
}

func TestWriteArchiveIncludesChecksummedManifest(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	evidenceStorage, err := objectstore.NewLocal(filepath.Join(directory, "evidence"))
	if err != nil {
		t.Fatal(err)
	}
	evidence := []byte("evidence-binary")
	if err := evidenceStorage.Put(context.Background(), "source/evidence", "image/png", evidence); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(directory, "backup.zip")
	prepared := backupFixture([]EvidenceEntry{{
		ArchivePath: "evidence/thread-1.png", ObjectKey: "source/evidence",
		ContentType: "image/png", ExpectedSHA256: SHA256Bytes(evidence),
	}})
	result, err := WriteArchive(context.Background(), prepared, evidenceStorage, target, func() time.Time {
		return time.Date(2026, 8, 9, 1, 0, 0, 0, time.UTC)
	})
	if err != nil {
		t.Fatal(err)
	}
	fileHash, err := SHA256File(target)
	if err != nil || fileHash != result.SHA256 || result.EntryCounts["threads.csv"] != 1 || result.EntryCounts["evidence"] != 1 {
		t.Fatalf("archive result=%+v fileHash=%s err=%v", result, fileHash, err)
	}
	if !VerifyArchive(target) {
		t.Fatal("生成archiveのmanifest検証に失敗しました")
	}
	manifest := readArchiveEntry(t, target, "manifest.json")
	for _, fragment := range []string{
		`"schemaVersion":"1"`, `"generatedAt":"2026-08-09T01:00:00Z"`,
		`"historyCoverageStartedAt":"2026-08-09T00:00:00Z"`, `"evidence":1`,
	} {
		if !strings.Contains(manifest, fragment) {
			t.Fatalf("manifestに%sがありません: %s", fragment, manifest)
		}
	}
}

func TestWriteArchiveIsByteDeterministic(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	storage, err := objectstore.NewLocal(filepath.Join(directory, "evidence"))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := func() time.Time { return time.Date(2026, 8, 9, 1, 2, 3, 0, time.UTC) }
	firstPath := filepath.Join(directory, "first.zip")
	secondPath := filepath.Join(directory, "second.zip")
	first, err := WriteArchive(context.Background(), backupFixture(nil), storage, firstPath, fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	second, err := WriteArchive(context.Background(), backupFixture(nil), storage, secondPath, fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	firstBytes, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	secondBytes, err := os.ReadFile(secondPath)
	if err != nil {
		t.Fatal(err)
	}
	if first.SHA256 != second.SHA256 || !bytes.Equal(firstBytes, secondBytes) {
		t.Fatalf("同一入力のbackup ZIPが一致しません: first=%s second=%s", first.SHA256, second.SHA256)
	}
}

func TestWriteArchiveRejectsEvidenceMismatchAndRemovesPartial(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	storage, err := objectstore.NewLocal(filepath.Join(directory, "evidence"))
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Put(context.Background(), "source/evidence", "image/png", []byte("changed")); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(directory, "invalid.zip")
	_, err = WriteArchive(context.Background(), backupFixture([]EvidenceEntry{{
		ArchivePath: "evidence/thread-1.png", ObjectKey: "source/evidence",
		ContentType: "image/png", ExpectedSHA256: strings.Repeat("0", 64),
	}}), storage, target, time.Now)
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("WriteArchive() error=%v", err)
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatalf("失敗archiveが残りました: %v", statErr)
	}
}

func TestVerifyArchiveRejectsExtraEntry(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	storage, _ := objectstore.NewLocal(filepath.Join(directory, "evidence"))
	original := filepath.Join(directory, "original.zip")
	if _, err := WriteArchive(context.Background(), backupFixture(nil), storage, original, time.Now); err != nil {
		t.Fatal(err)
	}
	modified := filepath.Join(directory, "modified.zip")
	input, err := zip.OpenReader(original)
	if err != nil {
		t.Fatal(err)
	}
	outputFile, _ := os.Create(modified)
	output := zip.NewWriter(outputFile)
	for _, file := range input.File {
		reader, _ := file.Open()
		data, _ := io.ReadAll(reader)
		reader.Close()
		writer, _ := output.Create(file.Name)
		_, _ = writer.Write(data)
	}
	writer, _ := output.Create("unexpected.txt")
	_, _ = writer.Write([]byte("unexpected"))
	_ = output.Close()
	_ = outputFile.Close()
	_ = input.Close()
	if VerifyArchive(modified) {
		t.Fatal("manifestにないentryを受理しました")
	}
}

func backupFixture(evidence []EvidenceEntry) PreparedArchive {
	body := `=HYPERLINK("bad")`
	return PreparedArchive{
		RunID: "00000000-0000-4000-8000-000000000001", Kind: KindFull,
		ScheduledFor: "2026-08-09T00:00:00Z", TenantKey: "tenant", ApplicationKey: "application",
		EnvironmentKey: "production", ExternalWorkspaceKey: "workspace",
		ToChangeSequence: 10, ToAuditSequence: 20,
		HistoryCoverageStartedAt: "2026-08-09T00:00:00Z", IncludeEvidence: len(evidence) != 0,
		CSVEntries: []CSVEntry{{
			Path: "threads.csv", Header: []string{"thread_id", "body"},
			Rows: [][]*string{{backupString("thread-1"), &body}},
		}},
		EvidenceEntries: evidence,
	}
}

func readArchiveEntry(t *testing.T, path, name string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range archive.File {
		if file.Name == name {
			reader, _ := file.Open()
			contents, _ := io.ReadAll(reader)
			reader.Close()
			return string(contents)
		}
	}
	t.Fatalf("%sがありません", name)
	return ""
}

func backupString(value string) *string { return &value }
