package export

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestRenderCSVMatchesKotlinFixture(t *testing.T) {
	t.Parallel()
	row := fixtureRow(`=HYPERLINK("https://attacker.invalid")`)
	actual, err := Render(FormatCSV, "ja-JP", "Asia/Tokyo", []Row{row})
	if err != nil {
		t.Fatal(err)
	}
	want := "\ufeff\"スレッドID\",\"番号\",\"セッションID\",\"状態\",\"観点\",\"ページ\",\"ルート\",\"対象種別\",\"投稿者\",\"メッセージ数\",\"最新メッセージ\",\"対象アプリへのリンク\",\"証跡\",\"作成日時\",\"更新日時\"\r\n" +
		"\"thread-1\",\"1\",\"session-1\",\"open\",\"quality\",\"orders.detail\",\"/orders/{id}\",\"ui-element\",\"利用者\",\"1\",\"'=HYPERLINK(\"\"https://attacker.invalid\"\")\",\"https://consumer.example/orders/O-1?feedbackThread=thread-1\",\"true\",\"2026-08-09 09:00:00 Asia/Tokyo\",\"2026-08-09 09:00:00 Asia/Tokyo\"\r\n"
	if string(actual) != want {
		t.Fatalf("CSV mismatch\nactual=%q\nwant  =%q", actual, want)
	}
}

func TestRenderXLSXNeverEmitsFormulaCell(t *testing.T) {
	t.Parallel()
	data, err := Render(FormatXLSX, "ja-JP", "Asia/Tokyo", []Row{fixtureRow(" =1+1")})
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	var sheet string
	for _, file := range archive.File {
		if file.Name != "xl/worksheets/sheet1.xml" {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		contents, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		sheet = string(contents)
	}
	if !strings.Contains(sheet, "&apos; =1+1") || strings.Contains(sheet, "<f>") {
		t.Fatalf("sheet XML = %s", sheet)
	}
}

func TestBuildDeepLinkUsesOnlyStoredParameters(t *testing.T) {
	t.Parallel()
	manifest := []byte(`{"routes":[{"pageKey":"orders.detail","template":"/orders/{id}","parameters":{"id":{"persistence":"store"}},"queryParameters":{"tab":{"persistence":"store"},"secret":{"persistence":"hash"}}}]}`)
	location := []byte(`{"pageKey":"orders.detail","routeTemplate":"/orders/{id}","pathParameters":{"id":"O 1"},"queryParameters":{"tab":"history","secret":"sha256:deadbeef"}}`)
	actual, err := BuildDeepLink("https://consumer.example", "feedbackThread", manifest, location, "thread-1")
	if err != nil {
		t.Fatal(err)
	}
	if actual != "https://consumer.example/orders/O%201?tab=history&feedbackThread=thread-1" {
		t.Fatalf("deep link = %q", actual)
	}
	hashed := []byte(`{"pageKey":"orders.detail","routeTemplate":"/orders/{id}","pathParameters":{"id":"sha256:secret"}}`)
	actual, err = BuildDeepLink("https://consumer.example/app", "thread", manifest, hashed, "thread-1")
	if err != nil || actual != "https://consumer.example/app/?thread=thread-1" || strings.Contains(actual, "secret") {
		t.Fatalf("fallback = %q, %v", actual, err)
	}
}

func TestBuildDeepLinkPreservesKotlinJSONObjectOrder(t *testing.T) {
	t.Parallel()
	manifest := []byte(`{"routes":[{"pageKey":"page","template":"/page","queryParameters":{"z":{"persistence":"store"},"aa":{"persistence":"store"}}}]}`)
	location := []byte(`{"pageKey":"page","routeTemplate":"/page","queryParameters":{"z":"first","aa":"second"}}`)
	actual, err := BuildDeepLink("https://consumer.example", "thread", manifest, location, "thread-1")
	if err != nil {
		t.Fatal(err)
	}
	if actual != "https://consumer.example/page?z=first&aa=second&thread=thread-1" {
		t.Fatalf("deep link order=%q", actual)
	}
}

func TestEscapeSpreadsheetValueCoversControlPrefix(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"=1", " +1", "\x00\t-1", "@cmd"} {
		if got := EscapeSpreadsheetValue(value); got != "'"+value {
			t.Fatalf("EscapeSpreadsheetValue(%q) = %q", value, got)
		}
	}
	if got := EscapeSpreadsheetValue("safe"); got != "safe" {
		t.Fatalf("safe = %q", got)
	}
}

func fixtureRow(latest string) Row {
	return Row{
		ThreadID: "thread-1", DisplayNumber: 1, SessionID: "session-1", Status: "open",
		PerspectiveCode: "quality", PageKey: "orders.detail", RouteTemplate: "/orders/{id}",
		TargetKind: "ui-element", ReporterName: "利用者", MessageCount: 1, LatestMessage: latest,
		DeepLink: "https://consumer.example/orders/O-1?feedbackThread=thread-1", EvidenceAvailable: true,
		CreatedAt: "2026-08-09T00:00:00Z", UpdatedAt: "2026-08-09T00:00:00Z",
	}
}
