package backuppull

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/backup"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

func TestClientRunsOAuthPaginationChecksumAndAtomicReplacement(t *testing.T) {
	directory := t.TempDir()
	archivePath := createPullArchive(t, directory)
	hash, err := backup.SHA256File(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archiveInfo, err := os.Stat(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	run := pullRun(hash, archiveInfo.Size())
	var tokenRequests, listRequests, downloads atomic.Int32
	var tokenBody string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/token":
			tokenRequests.Add(1)
			body, _ := io.ReadAll(request.Body)
			tokenBody = string(body)
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"access_token":"short-token","token_type":"Bearer"}`))
		case request.URL.Path == "/api/backups":
			if request.Header.Get("Authorization") != "Bearer short-token" {
				t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
			}
			listRequests.Add(1)
			page := Page{Items: []Run{run}, NextCursor: pullString("next")}
			if request.URL.Query().Get("cursor") == "next" {
				page = Page{Items: []Run{}}
			}
			_ = json.NewEncoder(writer).Encode(page)
		case request.URL.Path == "/api"+*run.DownloadURL:
			downloads.Add(1)
			data, _ := os.ReadFile(archivePath)
			_, _ = writer.Write(data)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	settings := pullSettings(server.URL, filepath.Join(directory, "mounted-share"))
	client, _ := NewClient(server.Client())
	if err := client.Run(context.Background(), settings); err != nil {
		t.Fatal(err)
	}
	name, _ := BackupFileName(run)
	target := filepath.Join(settings.DestinationDirectory, name)
	if !backup.VerifyArchive(target) || downloads.Load() != 1 || listRequests.Load() != 2 || tokenRequests.Load() != 1 {
		t.Fatalf("downloads=%d lists=%d tokens=%d verified=%v", downloads.Load(), listRequests.Load(), tokenRequests.Load(), backup.VerifyArchive(target))
	}
	if !strings.Contains(tokenBody, "grant_type=client_credentials") || !strings.Contains(tokenBody, "scope=feedback.manage") {
		t.Fatalf("token body = %q", tokenBody)
	}
	if err := client.Run(context.Background(), settings); err != nil {
		t.Fatal(err)
	}
	if downloads.Load() != 1 {
		t.Fatal("検証済みarchiveを再取得しました")
	}
	if err := os.WriteFile(target, []byte("corrupt"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := client.Run(context.Background(), settings); err != nil {
		t.Fatal(err)
	}
	if downloads.Load() != 2 || !backup.VerifyArchive(target) {
		t.Fatal("破損archiveがatomic replacementされませんでした")
	}
	entries, _ := os.ReadDir(settings.DestinationDirectory)
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".part") {
			t.Fatalf("temporary fileが残りました: %s", entry.Name())
		}
	}
}

func TestPullRejectsChecksumAndUnsafePaths(t *testing.T) {
	directory := t.TempDir()
	if err := ValidateDestination("/"); err == nil {
		t.Fatal("filesystem rootを受理しました")
	}
	for _, name := range []string{"../outside.zip", "sub/outside.zip", "..", ""} {
		if _, err := ResolveTarget(directory, name); err == nil {
			t.Fatalf("unsafe nameを受理しました: %q", name)
		}
	}
	archivePath := createPullArchive(t, directory)
	archiveInfo, err := os.Stat(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	run := pullRun(strings.Repeat("0", 64), archiveInfo.Size())
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		data, _ := os.ReadFile(archivePath)
		_, _ = writer.Write(data)
	}))
	defer server.Close()
	destination := filepath.Join(directory, "share")
	if err := os.MkdirAll(destination, 0o750); err != nil {
		t.Fatal(err)
	}
	settings := pullSettings(server.URL, destination)
	client, _ := NewClient(server.Client())
	if err := client.Pull(context.Background(), settings, "token", run); err == nil {
		t.Fatal("checksum mismatchを受理しました")
	}
	name, _ := BackupFileName(run)
	if _, err := os.Stat(filepath.Join(destination, name)); !os.IsNotExist(err) {
		t.Fatalf("不正archiveが配置されました: %v", err)
	}
}

func TestClientRejectsRedirectWithoutLeakingCredentials(t *testing.T) {
	t.Parallel()
	var redirectedRequests atomic.Int32
	sink := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirectedRequests.Add(1)
	}))
	defer sink.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, sink.URL+request.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()
	client, err := NewClient(redirector.Client())
	if err != nil {
		t.Fatal(err)
	}
	settings := pullSettings(redirector.URL, t.TempDir())
	if _, err := client.RequestToken(context.Background(), settings); err == nil {
		t.Fatal("OAuth redirectを受理しました")
	}
	if _, err := client.ListRuns(context.Background(), settings, "bearer-secret"); err == nil {
		t.Fatal("backup API redirectを受理しました")
	}
	if redirectedRequests.Load() != 0 {
		t.Fatalf("credential付きrequestをredirect先へ送信しました: %d", redirectedRequests.Load())
	}
}

func TestClientRejectsOversizedAndCyclicMetadataResponses(t *testing.T) {
	t.Parallel()
	var listRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/oversized-token":
			_, _ = writer.Write([]byte(`{"access_token":"token"}` + strings.Repeat(" ", tokenResponseMaximum)))
		case "/trailing-token":
			_, _ = writer.Write([]byte(`{"access_token":"token"}{}`))
		case "/api/backups":
			listRequests.Add(1)
			_ = json.NewEncoder(writer).Encode(Page{NextCursor: pullString("same-cursor")})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.Client())
	if err != nil {
		t.Fatal(err)
	}
	settings := pullSettings(server.URL, t.TempDir())
	for _, path := range []string{"/oversized-token", "/trailing-token"} {
		settings.TokenURL = server.URL + path
		if _, err := client.RequestToken(context.Background(), settings); err == nil {
			t.Fatalf("不正なtoken responseを受理しました: %s", path)
		}
	}
	if _, err := client.ListRuns(context.Background(), settings, "token"); err == nil {
		t.Fatal("循環するbackup cursorを受理しました")
	}
	if listRequests.Load() != 2 {
		t.Fatalf("cursor循環検出までのrequest数=%d", listRequests.Load())
	}
}

func TestPullRejectsArchiveLargerThanMetadata(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.(http.Flusher).Flush()
		_, _ = writer.Write(make([]byte, 1024))
	}))
	defer server.Close()
	settings := pullSettings(server.URL, t.TempDir())
	if err := os.MkdirAll(settings.DestinationDirectory, 0o750); err != nil {
		t.Fatal(err)
	}
	run := pullRun(strings.Repeat("0", 64), 10)
	client, err := NewClient(server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Pull(context.Background(), settings, "token", run); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("archive size mismatch error=%v", err)
	}
	entries, err := os.ReadDir(settings.DestinationDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("size不一致の一時fileが残りました: %v", entries)
	}
}

func TestRunRejectsCompletedBackupWithoutRequiredMetadata(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/token":
			_, _ = writer.Write([]byte(`{"access_token":"token"}`))
		case "/api/backups":
			_ = json.NewEncoder(writer).Encode(Page{Items: []Run{{
				ID: "00000000-0000-4000-8000-000000000011", Status: backup.StatusCompleted,
			}}})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Run(context.Background(), pullSettings(server.URL, t.TempDir())); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("completed backup metadata欠落error=%v", err)
	}
}

func TestParseSettingsRequiresManageAndDedicatedDestination(t *testing.T) {
	t.Parallel()
	environment := map[string]string{
		"FEEDBACK_PULL_API_BASE_URL": "https://feedback.example/api",
		"FEEDBACK_PULL_TOKEN_URL":    "https://issuer.example/token",
		"FEEDBACK_PULL_CLIENT_ID":    "puller", "FEEDBACK_PULL_CLIENT_SECRET": "secret",
		"FEEDBACK_PULL_APPLICATION_KEY": "app", "FEEDBACK_PULL_EXTERNAL_WORKSPACE_KEY": "workspace",
		"FEEDBACK_PULL_DESTINATION_DIR": filepath.Join(t.TempDir(), "backup"),
	}
	lookup := func(name string) (string, bool) { value, ok := environment[name]; return value, ok }
	settings, err := ParseSettings(lookup)
	if err != nil || settings.Scope != "feedback.manage" {
		t.Fatalf("ParseSettings()=%+v err=%v", settings, err)
	}
	environment["FEEDBACK_PULL_SCOPE"] = "feedback.read"
	if _, err := ParseSettings(lookup); err == nil {
		t.Fatal("manageなしscopeを受理しました")
	}
}

func createPullArchive(t *testing.T, directory string) string {
	t.Helper()
	storage, err := objectstore.NewLocal(filepath.Join(directory, "empty-evidence"))
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(directory, "source-"+time.Now().Format("150405.000000000")+".zip")
	thread := "thread-1"
	_, err = backup.WriteArchive(context.Background(), backup.PreparedArchive{
		RunID: "00000000-0000-4000-8000-000000000010", Kind: backup.KindFull,
		ScheduledFor: "2026-08-09T00:00:00Z", TenantKey: "tenant", ApplicationKey: "app",
		EnvironmentKey: "production", ExternalWorkspaceKey: "workspace", ToChangeSequence: 1, ToAuditSequence: 1,
		HistoryCoverageStartedAt: "2026-08-09T00:00:00Z",
		CSVEntries:               []backup.CSVEntry{{Path: "threads.csv", Header: []string{"thread_id"}, Rows: [][]*string{{&thread}}}},
	}, storage, target, func() time.Time { return time.Date(2026, 8, 9, 0, 0, 1, 0, time.UTC) })
	if err != nil {
		t.Fatal(err)
	}
	return target
}

func pullRun(hash string, archiveBytes int64) Run {
	download := "/backups/00000000-0000-4000-8000-000000000011/download"
	return Run{
		ID: "00000000-0000-4000-8000-000000000011", Kind: backup.KindFull,
		Status: backup.StatusCompleted, ScheduledFor: "2026-08-09T00:00:00Z", DownloadURL: &download,
		FromChangeSequence: 0, ToChangeSequence: pullInt64(1), FromAuditSequence: 0, ToAuditSequence: pullInt64(1),
		ArchiveSHA256: &hash, ArchiveBytes: &archiveBytes,
		HistoryCoverageStartedAt: "2026-08-09T00:00:00Z", CreatedAt: "2026-08-09T00:00:00Z",
	}
}

func pullSettings(serverURL, destination string) Settings {
	return Settings{
		APIBaseURL: serverURL + "/api", TokenURL: serverURL + "/token",
		ClientID: "backup-puller", ClientSecret: "client-secret", Scope: "feedback.manage",
		ApplicationKey: "app", ExternalWorkspaceKey: "workspace", DestinationDirectory: destination,
	}
}

func pullString(value string) *string { return &value }
func pullInt64(value int64) *int64    { return &value }
