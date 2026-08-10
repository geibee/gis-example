package differential

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestKotlinAndGoLiveBehavior(t *testing.T) {
	kotlinURL := os.Getenv("FEEDBACK_DIFFERENTIAL_KOTLIN_URL")
	goURL := os.Getenv("FEEDBACK_DIFFERENTIAL_GO_URL")
	if kotlinURL == "" || goURL == "" {
		t.Skip("分離されたKotlin/Go server URLが未設定です")
	}
	contents, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contracts", "feedback", "behavior", "http-v1.json"))
	if err != nil {
		t.Fatalf("fixtureを読めません: %v", err)
	}
	suite, err := LoadSuite(contents)
	if err != nil {
		t.Fatalf("fixtureが不正です: %v", err)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	kotlinResults, err := Run(context.Background(), client, kotlinURL, suite)
	if err != nil {
		t.Fatalf("Kotlin版の実行に失敗しました: %v", err)
	}
	goResults, err := Run(context.Background(), client, goURL, suite)
	if err != nil {
		t.Fatalf("Go版の実行に失敗しました: %v", err)
	}
	if err := Compare(suite, kotlinResults, goResults); err != nil {
		t.Fatal(err)
	}
}
