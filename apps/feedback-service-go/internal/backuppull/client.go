// Package backuppull はcompleted backupをOAuth client credentialsで専用pathへ同期する。
package backuppull

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/backup"
)

var (
	ErrInvalidSettings = errors.New("backup pull設定が不正です")
	ErrRemote          = errors.New("backup pull API呼出に失敗しました")
	ErrIntegrity       = errors.New("backup archiveの整合性が不正です")
)

const (
	metadataRequestTimeout = 30 * time.Second
	archiveRequestTimeout  = 5 * time.Minute
	tokenResponseMaximum   = 1024 * 1024
	listResponseMaximum    = 16 * 1024 * 1024
	maximumListPages       = 10_000
)

type Error struct {
	Kind   error
	Code   string
	Detail string
}

func (err *Error) Error() string { return err.Detail }
func (err *Error) Unwrap() error { return err.Kind }

type LookupFunc func(string) (string, bool)

type Settings struct {
	APIBaseURL           string
	TokenURL             string
	ClientID             string
	ClientSecret         string
	Scope                string
	ApplicationKey       string
	ExternalWorkspaceKey string
	DestinationDirectory string
}

type Run = backup.Run
type Page = backup.Page

type Client struct{ httpClient *http.Client }

func NewClient(httpClient *http.Client) (*Client, error) {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 5 * time.Minute}
	}
	isolated := *httpClient
	// OAuth client secretとBearer tokenをredirect先へ再送しない。Java v1 clientの
	// Redirect.NEVER境界と同じく、3xxは呼出側で通常のremote failureとして扱う。
	isolated.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{httpClient: &isolated}, nil
}

func ParseSettings(lookup LookupFunc) (Settings, error) {
	if lookup == nil {
		return Settings{}, &Error{Kind: ErrInvalidSettings, Code: "settings.invalid", Detail: "環境変数参照が未設定です"}
	}
	required := func(name string) (string, error) {
		value, ok := lookup(name)
		if !ok || strings.TrimSpace(value) == "" {
			return "", &Error{Kind: ErrInvalidSettings, Code: "settings.required", Detail: name + " が必要です"}
		}
		return value, nil
	}
	apiBaseURL, err := required("FEEDBACK_PULL_API_BASE_URL")
	if err != nil {
		return Settings{}, err
	}
	tokenURL, err := required("FEEDBACK_PULL_TOKEN_URL")
	if err != nil {
		return Settings{}, err
	}
	clientID, err := required("FEEDBACK_PULL_CLIENT_ID")
	if err != nil {
		return Settings{}, err
	}
	clientSecret, err := required("FEEDBACK_PULL_CLIENT_SECRET")
	if err != nil {
		return Settings{}, err
	}
	applicationKey, err := required("FEEDBACK_PULL_APPLICATION_KEY")
	if err != nil {
		return Settings{}, err
	}
	workspaceKey, err := required("FEEDBACK_PULL_EXTERNAL_WORKSPACE_KEY")
	if err != nil {
		return Settings{}, err
	}
	destination, err := required("FEEDBACK_PULL_DESTINATION_DIR")
	if err != nil {
		return Settings{}, err
	}
	absolute, err := filepath.Abs(destination)
	if err != nil {
		return Settings{}, &Error{Kind: ErrInvalidSettings, Code: "settings.invalid", Detail: "backup destinationを解決できません"}
	}
	absolute = filepath.Clean(absolute)
	if err := ValidateDestination(absolute); err != nil {
		return Settings{}, err
	}
	scope := "feedback.manage"
	if value, ok := lookup("FEEDBACK_PULL_SCOPE"); ok && strings.TrimSpace(value) != "" {
		scope = value
	}
	if !containsField(scope, "feedback.manage") {
		return Settings{}, &Error{
			Kind: ErrInvalidSettings, Code: "settings.invalid",
			Detail: "FEEDBACK_PULL_SCOPE にはfeedback.manageが必要です",
		}
	}
	if err := validateHTTPURL(apiBaseURL); err != nil {
		return Settings{}, err
	}
	if err := validateHTTPURL(tokenURL); err != nil {
		return Settings{}, err
	}
	return Settings{
		APIBaseURL: strings.TrimRight(apiBaseURL, "/"), TokenURL: tokenURL,
		ClientID: clientID, ClientSecret: clientSecret, Scope: scope,
		ApplicationKey: applicationKey, ExternalWorkspaceKey: workspaceKey,
		DestinationDirectory: absolute,
	}, nil
}

func ValidateDestination(destination string) error {
	if !filepath.IsAbs(destination) || filepath.Clean(destination) == filepath.VolumeName(destination)+string(filepath.Separator) {
		return &Error{
			Kind: ErrInvalidSettings, Code: "settings.invalid",
			Detail: "FEEDBACK_PULL_DESTINATION_DIR にfilesystem rootは指定できません",
		}
	}
	return nil
}

func ResolveTarget(destination, name string) (string, error) {
	if strings.TrimSpace(name) == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return "", &Error{Kind: ErrInvalidSettings, Code: "path.invalid", Detail: "不正なbackup filenameです"}
	}
	target := filepath.Clean(filepath.Join(destination, name))
	if filepath.Dir(target) != destination {
		return "", &Error{Kind: ErrInvalidSettings, Code: "path.invalid", Detail: "不正なbackup filenameです"}
	}
	return target, nil
}

func BackupFileName(run Run) (string, error) {
	if run.Kind != backup.KindFull && run.Kind != backup.KindIncremental {
		return "", &Error{Kind: ErrInvalidSettings, Code: "backup.invalid", Detail: "不正なbackup kindです"}
	}
	id, err := uuid.Parse(run.ID)
	if err != nil {
		return "", &Error{Kind: ErrInvalidSettings, Code: "backup.invalid", Detail: "不正なbackup IDです"}
	}
	scheduled, err := time.Parse(time.RFC3339Nano, run.ScheduledFor)
	if err != nil {
		return "", &Error{Kind: ErrInvalidSettings, Code: "backup.invalid", Detail: "不正なscheduledForです"}
	}
	return fmt.Sprintf("%s-%s-%s.zip", scheduled.UTC().Format("20060102T150405Z"), run.Kind, id.String()), nil
}

func (client *Client) Run(ctx context.Context, settings Settings) error {
	if err := ValidateDestination(settings.DestinationDirectory); err != nil {
		return err
	}
	token, err := client.RequestToken(ctx, settings)
	if err != nil {
		return err
	}
	runs, err := client.ListRuns(ctx, settings, token)
	if err != nil {
		return err
	}
	filtered := make([]Run, 0, len(runs))
	for _, run := range runs {
		if run.Status != backup.StatusCompleted {
			continue
		}
		if run.DownloadURL == nil || run.ArchiveSHA256 == nil || run.ArchiveBytes == nil || *run.ArchiveBytes <= 0 {
			return &Error{
				Kind: ErrIntegrity, Code: "backup.metadata_invalid",
				Detail: fmt.Sprintf("completed backup %s の必須metadataがありません", run.ID),
			}
		}
		filtered = append(filtered, run)
	}
	sort.SliceStable(filtered, func(left, right int) bool {
		leftTime, _ := time.Parse(time.RFC3339Nano, filtered[left].ScheduledFor)
		rightTime, _ := time.Parse(time.RFC3339Nano, filtered[right].ScheduledFor)
		return leftTime.Before(rightTime)
	})
	if err := os.MkdirAll(settings.DestinationDirectory, 0o750); err != nil {
		return fmt.Errorf("backup destinationを作成できません: %w", err)
	}
	for _, run := range filtered {
		if err := client.Pull(ctx, settings, token, run); err != nil {
			return err
		}
	}
	return nil
}

func (client *Client) RequestToken(ctx context.Context, settings Settings) (string, error) {
	body := formEncode([][2]string{
		{"grant_type", "client_credentials"}, {"client_id", settings.ClientID},
		{"client_secret", settings.ClientSecret}, {"scope", settings.Scope},
	})
	requestCtx, cancel := context.WithTimeout(ctx, metadataRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, settings.TokenURL, strings.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return "", &Error{Kind: ErrRemote, Code: "oauth.unavailable", Detail: "OIDC token の取得に失敗しました"}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return "", &Error{Kind: ErrRemote, Code: "oauth.failed", Detail: fmt.Sprintf("OIDC token の取得に失敗しました: HTTP %d", response.StatusCode)}
	}
	var token struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if err := decodeBoundedJSON(response.Body, tokenResponseMaximum, &token); err != nil || token.AccessToken == "" {
		return "", &Error{Kind: ErrRemote, Code: "oauth.invalid_response", Detail: "OIDC token responseが不正です"}
	}
	return token.AccessToken, nil
}

func (client *Client) ListRuns(ctx context.Context, settings Settings, token string) ([]Run, error) {
	result := make([]Run, 0)
	var cursor *string
	seenCursors := make(map[string]struct{})
	for pageIndex := 0; pageIndex < maximumListPages; pageIndex++ {
		requestCtx, cancel := context.WithTimeout(ctx, metadataRequestTimeout)
		fields := [][2]string{
			{"applicationKey", settings.ApplicationKey}, {"externalWorkspaceKey", settings.ExternalWorkspaceKey}, {"limit", "200"},
		}
		if cursor != nil {
			fields = append(fields, [2]string{"cursor", *cursor})
		}
		request, err := http.NewRequestWithContext(
			requestCtx, http.MethodGet, settings.APIBaseURL+"/backups?"+formEncode(fields), nil,
		)
		if err != nil {
			cancel()
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := client.httpClient.Do(request)
		if err != nil {
			cancel()
			return nil, &Error{Kind: ErrRemote, Code: "backup.list_unavailable", Detail: "backup list の取得に失敗しました"}
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			cancel()
			return nil, &Error{Kind: ErrRemote, Code: "backup.list_failed", Detail: fmt.Sprintf("backup list の取得に失敗しました: HTTP %d", response.StatusCode)}
		}
		var page Page
		err = decodeBoundedJSON(response.Body, listResponseMaximum, &page)
		response.Body.Close()
		cancel()
		if err != nil || len(page.Items) > 200 {
			return nil, &Error{Kind: ErrRemote, Code: "backup.list_invalid", Detail: "backup list responseが不正です"}
		}
		result = append(result, page.Items...)
		cursor = page.NextCursor
		if cursor == nil {
			return result, nil
		}
		if *cursor == "" {
			return nil, &Error{Kind: ErrRemote, Code: "backup.list_invalid", Detail: "backup list cursorが不正です"}
		}
		if _, duplicated := seenCursors[*cursor]; duplicated {
			return nil, &Error{Kind: ErrRemote, Code: "backup.list_invalid", Detail: "backup list cursorが循環しています"}
		}
		seenCursors[*cursor] = struct{}{}
	}
	return nil, &Error{Kind: ErrRemote, Code: "backup.list_invalid", Detail: "backup list page数が上限を超えました"}
}

func decodeBoundedJSON(reader io.Reader, maximum int64, target any) error {
	if reader == nil || target == nil || maximum <= 0 {
		return errors.New("JSON response readerまたは上限が不正です")
	}
	raw, err := io.ReadAll(io.LimitReader(reader, maximum+1))
	if err != nil {
		return err
	}
	if int64(len(raw)) > maximum {
		return errors.New("JSON responseが上限を超えました")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("JSON responseに複数の値があります")
	}
	return nil
}

func (client *Client) Pull(ctx context.Context, settings Settings, token string, run Run) error {
	if run.ArchiveBytes == nil || *run.ArchiveBytes <= 0 || *run.ArchiveBytes == math.MaxInt64 {
		return &Error{Kind: ErrIntegrity, Code: "backup.metadata_invalid", Detail: "backup archiveBytesが不正です"}
	}
	expectedBytes := *run.ArchiveBytes
	name, err := BackupFileName(run)
	if err != nil {
		return err
	}
	target, err := ResolveTarget(settings.DestinationDirectory, name)
	if err != nil {
		return err
	}
	if info, err := os.Stat(target); err == nil && info.Mode().IsRegular() {
		hash, hashErr := backup.SHA256File(target)
		if hashErr == nil && info.Size() == expectedBytes && run.ArchiveSHA256 != nil &&
			hash == *run.ArchiveSHA256 && backup.VerifyArchive(target) {
			return nil
		}
	}
	temporary, err := os.CreateTemp(settings.DestinationDirectory, "."+name+"-*.part")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	complete := false
	defer func() {
		_ = temporary.Close()
		if !complete {
			_ = os.Remove(temporaryPath)
		}
	}()
	requestCtx, cancel := context.WithTimeout(ctx, archiveRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, settings.APIBaseURL+*run.DownloadURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return &Error{Kind: ErrRemote, Code: "backup.download_unavailable", Detail: "backupの取得に失敗しました"}
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return &Error{Kind: ErrRemote, Code: "backup.download_failed", Detail: fmt.Sprintf("backup %s の取得に失敗しました: HTTP %d", run.ID, response.StatusCode)}
	}
	if response.ContentLength >= 0 && response.ContentLength != expectedBytes {
		response.Body.Close()
		return &Error{Kind: ErrIntegrity, Code: "backup.size_mismatch", Detail: fmt.Sprintf("backup %s のbyte sizeが一致しません", run.ID)}
	}
	written, copyErr := io.Copy(temporary, io.LimitReader(response.Body, expectedBytes+1))
	closeBodyErr := response.Body.Close()
	if copyErr != nil || closeBodyErr != nil {
		return errors.Join(copyErr, closeBodyErr)
	}
	if written != expectedBytes {
		return &Error{Kind: ErrIntegrity, Code: "backup.size_mismatch", Detail: fmt.Sprintf("backup %s のbyte sizeが一致しません", run.ID)}
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	actual, err := backup.SHA256File(temporaryPath)
	if err != nil || run.ArchiveSHA256 == nil || actual != *run.ArchiveSHA256 {
		return &Error{Kind: ErrIntegrity, Code: "backup.checksum_mismatch", Detail: fmt.Sprintf("backup %s のSHA-256が一致しません", run.ID)}
	}
	if !backup.VerifyArchive(temporaryPath) {
		return &Error{Kind: ErrIntegrity, Code: "backup.manifest_invalid", Detail: fmt.Sprintf("backup %s のmanifest検証に失敗しました", run.ID)}
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		return fmt.Errorf("backup archiveをatomic配置できません: %w", err)
	}
	complete = true
	return nil
}

func formEncode(fields [][2]string) string {
	values := make([]string, 0, len(fields))
	for _, field := range fields {
		values = append(values, encode(field[0])+"="+encode(field[1]))
	}
	return strings.Join(values, "&")
}

func encode(value string) string { return strings.ReplaceAll(url.QueryEscape(value), "+", "%20") }

func containsField(raw, target string) bool {
	for _, field := range strings.Fields(raw) {
		if field == target {
			return true
		}
	}
	return false
}

func validateHTTPURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return &Error{Kind: ErrInvalidSettings, Code: "settings.invalid_url", Detail: "backup pull URLが不正です"}
	}
	return nil
}
