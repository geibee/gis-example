package session

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateCreateRejectsInvalidRequests(t *testing.T) {
	t.Parallel()
	valid := CreateRequest{
		ApplicationKey: "sample-app", EnvironmentKey: "production", ExternalWorkspaceKey: "workspace-1",
		ManifestVersion: "v1", Title: "レビュー", OutOfScopePosting: OutOfScopeWarn,
		Scopes:       []Scope{{PageKey: "home", Reviewable: true}},
		Perspectives: []Perspective{{Code: "ux", Label: "UX", Status: PerspectiveActive}},
	}
	tests := map[string]func(*CreateRequest){
		"application key": func(value *CreateRequest) { value.ApplicationKey = "Bad" },
		"title blank":     func(value *CreateRequest) { value.Title = " \t" },
		"UTF-16 title": func(value *CreateRequest) {
			value.Title = strings.Repeat("😀", 101)
		},
		"posting": func(value *CreateRequest) { value.OutOfScopePosting = "invalid" },
		"time order": func(value *CreateRequest) {
			start, end := "2026-08-09T10:00:00+09:00", "2026-08-09T00:59:59Z"
			value.StartAt, value.EndAt = &start, &end
		},
		"scope duplicate": func(value *CreateRequest) {
			value.Scopes = append(value.Scopes, value.Scopes[0])
		},
		"perspective duplicate": func(value *CreateRequest) {
			value.Perspectives = append(value.Perspectives, value.Perspectives[0])
		},
		"scope perspective unknown": func(value *CreateRequest) {
			value.Scopes[0].PerspectiveCodes = []string{"unknown"}
		},
		"scope perspective inactive": func(value *CreateRequest) {
			value.Perspectives[0].Status = PerspectiveFuture
			value.Scopes[0].PerspectiveCodes = []string{"ux"}
		},
		"scope perspective duplicate": func(value *CreateRequest) {
			value.Scopes[0].PerspectiveCodes = []string{"ux", "ux"}
		},
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			request := valid
			request.Scopes = append([]Scope(nil), valid.Scopes...)
			request.Perspectives = append([]Perspective(nil), valid.Perspectives...)
			mutate(&request)
			if err := ValidateCreate(request); !errors.Is(err, ErrInvalid) {
				t.Fatalf("ValidateCreate() error = %v, want ErrInvalid", err)
			}
		})
	}
}

func TestValidateCreateAcceptsKotlinBoundaries(t *testing.T) {
	t.Parallel()
	nullRoute := Scope{PageKey: "home", RouteTemplate: nil, Reviewable: true}
	empty := ""
	request := CreateRequest{
		ApplicationKey: "a", EnvironmentKey: " env ", ExternalWorkspaceKey: " workspace ",
		ManifestVersion: " v1 ", Title: strings.Repeat("😀", 100),
		Scopes: []Scope{nullRoute, {PageKey: "home", RouteTemplate: &empty}},
	}
	if err := ValidateCreate(request); err != nil {
		t.Fatalf("ValidateCreate() error = %v", err)
	}
	normalized := NormalizeCreate(request)
	if normalized.Title != request.Title || normalized.OutOfScopePosting != OutOfScopeWarn {
		t.Fatalf("NormalizeCreate() = %+v", normalized)
	}
}

func TestValidatePatchUsesKotlinExplicitNullComparison(t *testing.T) {
	t.Parallel()
	start, end := "2026-08-09T10:00:00Z", "2026-08-09T09:00:00Z"
	patch := Patch{
		ExpectedVersion: 1,
		StartAt:         OptionalString{Present: true, Value: nil},
		EndAt:           OptionalString{Present: true, Value: &end},
	}
	if err := ValidatePatch(patch, Session{StartAt: &start}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("ValidatePatch() error = %v, want explicit nullでもcurrent startとの比較error", err)
	}
}

func TestValidatePatchRejectsEmptyAndInvalidETagVersion(t *testing.T) {
	t.Parallel()
	tests := []Patch{{ExpectedVersion: 1}, {ExpectedVersion: 0, Title: stringPointer("title")}}
	for _, patch := range tests {
		if err := ValidatePatch(patch, Session{}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("ValidatePatch(%+v) error = %v", patch, err)
		}
	}
}

func TestValidatePatchValidatesReplacementChildren(t *testing.T) {
	t.Parallel()
	invalidScopes := []Scope{{PageKey: ""}}
	patch := Patch{ExpectedVersion: 1, Scopes: &invalidScopes}
	if err := ValidatePatch(patch, Session{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("不正scopeを受理しました: %v", err)
	}
	validScopes := []Scope{{PageKey: "orders.list", Reviewable: true, PerspectiveCodes: []string{"USABILITY"}}}
	validPerspectives := []Perspective{{Code: "USABILITY", Label: "操作性", Status: PerspectiveActive}}
	patch = Patch{ExpectedVersion: 1, Scopes: &validScopes, Perspectives: &validPerspectives}
	if err := ValidatePatch(patch, Session{}); err != nil {
		t.Fatalf("有効なchildren patchが拒否されました: %v", err)
	}
}

func TestCursorRoundTripAndNegativeCases(t *testing.T) {
	t.Parallel()
	for _, offset := range []int{0, 1, 200, 99999} {
		cursor := EncodeCursor(offset)
		got, err := DecodeCursor(&cursor)
		if err != nil || got != offset {
			t.Fatalf("offset=%d cursor=%q got=%d err=%v", offset, cursor, got, err)
		}
	}
	for _, cursor := range []string{"***", "bm90LW9mZnNldA", "b2Zmc2V0Oi0x", strings.Repeat("a", 2001)} {
		if _, err := DecodeCursor(&cursor); !errors.Is(err, ErrInvalid) {
			t.Fatalf("DecodeCursor(%q) error = %v", cursor, err)
		}
	}
	padded := "b2Zmc2V0OjE="
	if got, err := DecodeCursor(&padded); err != nil || got != 1 {
		t.Fatalf("padding付きcursor got=%d err=%v", got, err)
	}
	empty := ""
	if _, err := DecodeCursor(&empty); !errors.Is(err, ErrInvalid) {
		t.Fatalf("明示empty cursor error=%v", err)
	}
}

func TestNormalizeLimitDistinguishesOmittedAndZero(t *testing.T) {
	t.Parallel()
	if got, err := NormalizeLimit(nil); err != nil || got != 50 {
		t.Fatalf("omitted limit=%d err=%v", got, err)
	}
	zero := 0
	if _, err := NormalizeLimit(&zero); !errors.Is(err, ErrInvalid) {
		t.Fatalf("explicit zero error=%v", err)
	}
}

func TestHeaderAndIdentifierValidation(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		call func() error
		code string
	}{
		{name: "missing idempotency", call: func() error { return ValidateIdempotencyKey("") }, code: "idempotency.required"},
		{name: "short idempotency", call: func() error { return ValidateIdempotencyKey("short") }, code: "request.invalid"},
		{name: "uppercase hash", call: func() error {
			return ValidateRequestHash(strings.Repeat("A", 64))
		}, code: "request.invalid"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var validation *ValidationError
			if err := test.call(); !errors.As(err, &validation) || validation.Code != test.code {
				t.Fatalf("error = %v, want code %s", err, test.code)
			}
		})
	}
	canonical, err := ValidateUUID("550E8400-E29B-41D4-A716-446655440000", "sessionId")
	if err != nil || canonical != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("ValidateUUID() = %q, %v", canonical, err)
	}
}

func stringPointer(value string) *string { return &value }
