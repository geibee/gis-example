package httpapi

import (
	"strings"
	"testing"
)

func TestDecodeManifestAndSanitizeLocation(t *testing.T) {
	t.Parallel()
	body := []byte(`{
      "schemaVersion":"1",
      "applicationKey":"inventory",
      "displayName":"在庫",
      "manifestVersion":"v1",
      "routes":[{
        "pageKey":"item.detail",
        "template":"/items/{itemId}",
        "label":"商品",
        "parameters":{"itemId":{"persistence":"store"}},
        "queryParameters":{"token":{"persistence":"discard"},"filter":{"persistence":"hash"}},
        "aliases":["/legacy/{itemId}"]
      }]
    }`)
	manifest, err := DecodeManifest(body, "inventory")
	if err != nil {
		t.Fatal(err)
	}
	query := `{"token":"secret","filter":"active","unknown":"discarded"}`
	location, err := SanitizeLocation(manifest, "item.detail", "/legacy/{itemId}", `{"itemId":"42"}`, &query)
	if err != nil {
		t.Fatal(err)
	}
	if location.PathParameters["itemId"] != "42" {
		t.Fatalf("store policyが不正です: %+v", location)
	}
	if !strings.HasPrefix(location.QueryParameters["filter"], "sha256:") || len(location.QueryParameters["filter"]) != 71 {
		t.Fatalf("hash policyが不正です: %+v", location.QueryParameters)
	}
	if _, exists := location.QueryParameters["token"]; exists {
		t.Fatal("discard policyの値が残っています")
	}
	if _, exists := location.QueryParameters["unknown"]; exists {
		t.Fatal("未登録query parameterが残っています")
	}
}

func TestDecodeManifestRejectsContractViolations(t *testing.T) {
	t.Parallel()
	valid := `{"schemaVersion":"1","applicationKey":"inventory","displayName":"在庫","manifestVersion":"v1","routes":[{"pageKey":"home","template":"/","label":"ホーム"}]}`
	tests := []struct {
		name string
		body string
		key  string
	}{
		{name: "unknown field", body: strings.Replace(valid, `"routes":`, `"unknown":true,"routes":`, 1), key: "inventory"},
		{name: "path mismatch", body: valid, key: "other"},
		{name: "duplicate template", body: strings.Replace(valid, `]}`, `,{"pageKey":"other","template":"/","label":"他"}]}`, 1), key: "inventory"},
		{name: "missing path policy", body: strings.Replace(valid, `"template":"/"`, `"template":"/{id}"`, 1), key: "inventory"},
		{name: "trailing JSON", body: valid + `{}`, key: "inventory"},
		{name: "null optional", body: strings.Replace(valid, `"label":"ホーム"`, `"label":"ホーム","aliases":null`, 1), key: "inventory"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, err := DecodeManifest([]byte(test.body), test.key); err == nil {
				t.Fatal("不正manifestを受理しました")
			}
		})
	}
}

func TestSanitizeLocationRejectsInvalidValues(t *testing.T) {
	t.Parallel()
	parameters := map[string]ParameterPolicy{"id": {Persistence: "store"}}
	manifest := Manifest{
		SchemaVersion:   "1",
		ApplicationKey:  "inventory",
		DisplayName:     "在庫",
		ManifestVersion: "v1",
		Routes: []ManifestRoute{{
			PageKey: "detail", Template: "/items/{id}", Label: "詳細", Parameters: &parameters,
		}},
	}
	if _, err := SanitizeLocation(manifest, "detail", "/items/{id}", `{}`, nil); err == nil {
		t.Fatal("不足path parameterを受理しました")
	}
	if _, err := SanitizeLocation(manifest, "detail", "/items/{id}", `{"id":42}`, nil); err == nil {
		t.Fatal("string以外のpath parameterを受理しました")
	}
	if _, err := SanitizeLocation(manifest, "detail", "/items/{id}", `{"id":null}`, nil); err == nil {
		t.Fatal("nullのpath parameterを受理しました")
	}
	if _, err := SanitizeLocation(manifest, "unknown", "/", `{}`, nil); err == nil {
		t.Fatal("未登録locationを受理しました")
	}
}

func TestValidateKeyMatchesKotlinUTF16Length(t *testing.T) {
	t.Parallel()
	if _, err := ValidateKey(strings.Repeat("😀", 50), "label", 100); err != nil {
		t.Fatalf("UTF-16で100文字の値を拒否しました: %v", err)
	}
	if _, err := ValidateKey(strings.Repeat("😀", 51), "label", 100); err == nil {
		t.Fatal("UTF-16で102文字の値を受理しました")
	}
}

func TestPaginationConcurrencyHeadersAndStatusValidation(t *testing.T) {
	t.Parallel()
	canonical, err := ValidateUUID("550e8400-e29b-41d4-a716-446655440000", "sessionId")
	if err != nil || canonical != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("ValidateUUID()=%q err=%v", canonical, err)
	}
	if _, err := ValidateUUID("not-a-uuid", "sessionId"); err == nil {
		t.Fatal("不正UUIDを受理しました")
	}
	for _, key := range []string{strings.Repeat("a", 16), strings.Repeat("界", 200)} {
		if _, err := ValidateIdempotencyKey(key); err != nil {
			t.Fatalf("ValidateIdempotencyKey(%d)=%v", len(key), err)
		}
	}
	for _, key := range []string{strings.Repeat("a", 15), strings.Repeat("a", 201)} {
		if _, err := ValidateIdempotencyKey(key); err == nil {
			t.Fatalf("境界外idempotency keyを受理しました: %d", len(key))
		}
	}
	if _, err := ParseRequiredETag(""); err == nil {
		t.Fatal("空If-Matchを受理しました")
	}
	if version, err := ParseRequiredETag(`W/"v12"`); err != nil || version != 12 {
		t.Fatalf("ParseRequiredETag()=%d err=%v", version, err)
	}
	limit := 200
	if value, err := ParseLimit(&limit); err != nil || value != 200 {
		t.Fatalf("ParseLimit()=%d err=%v", value, err)
	}
	invalidLimit := 0
	if _, err := ParseLimit(&invalidLimit); err == nil {
		t.Fatal("limit=0を受理しました")
	}
	cursor := EncodeCursor(42)
	if offset, err := DecodeCursor(&cursor); err != nil || offset != 42 {
		t.Fatalf("DecodeCursor()=%d err=%v", offset, err)
	}
	invalidCursor := "bm90LWEtY3Vyc29y"
	if _, err := DecodeCursor(&invalidCursor); err == nil {
		t.Fatal("不正cursorを受理しました")
	}
	if _, err := ValidateSessionStatus("open"); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateSessionStatus("archived"); err == nil {
		t.Fatal("未知session statusを受理しました")
	}
	if _, err := ValidateThreadStatus("resolved"); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateThreadStatus("closed"); err == nil {
		t.Fatal("未知thread statusを受理しました")
	}
}

func TestCanonicalJSONSHA256MatchesKotlinElementNormalization(t *testing.T) {
	t.Parallel()
	left, err := CanonicalJSONSHA256([]byte(" { \"message\" : \"日本語\", \"values\" : [1, true, null] } \n"))
	if err != nil {
		t.Fatal(err)
	}
	right, err := CanonicalJSONSHA256([]byte(`{"message":"\u65e5\u672c\u8a9e","values":[1,true,null]}`))
	if err != nil {
		t.Fatal(err)
	}
	if left != right {
		t.Fatalf("同じJsonElementのhashが一致しません: %s %s", left, right)
	}
	if left != "179154d82fc056f272b04ea1532a9f56d80fd7d73cd4e9dc81fc9f89b1c49d5f" {
		t.Fatalf("Kotlin互換goldenと一致しません: %s", left)
	}
	reordered, err := CanonicalJSONSHA256([]byte(`{"values":[1,true,null],"message":"日本語"}`))
	if err != nil {
		t.Fatal(err)
	}
	if reordered == left {
		t.Fatal("Kotlin同様にobject入力順を保持していません")
	}
	if _, err := CanonicalJSONSHA256([]byte(`{} {}`)); err == nil {
		t.Fatal("複数JSON値を受理しました")
	}
}
