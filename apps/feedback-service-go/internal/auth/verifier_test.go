package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jwt"
)

var verifierTestNow = time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)

func TestDirectVerifier(t *testing.T) {
	t.Parallel()

	fixture := newJWTFixture(t, "direct-key")
	settings := directSettings()
	settings.SubjectClaim = "principal_id"
	verifier, err := newDirectVerifier(settings, fixture.source(), func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("verifierを作成できませんでした: %v", err)
	}
	token := directToken(t, map[string]any{
		"principal_id": "subject-a",
		"name":         "利用者A",
		"email":        "a@example.test",
	})
	identity, err := verifier.Verify(context.Background(), fixture.sign(t, token))
	if err != nil {
		t.Fatalf("tokenを検証できませんでした: %v", err)
	}
	if identity.Issuer != settings.Issuer || identity.Subject != "subject-a" {
		t.Fatalf("identity=%+v", identity)
	}
	if identity.Email == nil || *identity.Email != "a@example.test" || identity.DisplayName == nil || *identity.DisplayName != "利用者A" {
		t.Fatalf("optional identity claim=%+v", identity)
	}
}

func TestDirectVerifierRejectsInvalidJWT(t *testing.T) {
	t.Parallel()

	fixture := newJWTFixture(t, "direct-key")
	settings := directSettings()
	verifier, err := newDirectVerifier(settings, fixture.source(), func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("verifierを作成できませんでした: %v", err)
	}
	wrongFixture := newJWTFixture(t, "direct-key")

	tests := []struct {
		name  string
		token func(*testing.T) string
	}{
		{name: "malformed", token: func(*testing.T) string { return "not-a-jwt" }},
		{name: "alg none", token: func(*testing.T) string { return unsignedToken(`{"sub":"subject-a"}`) }},
		{
			name: "想定外algorithm",
			token: func(t *testing.T) string {
				return signWithHMAC(t, directToken(t, nil))
			},
		},
		{
			name: "issuer不一致",
			token: func(t *testing.T) string {
				token := directToken(t, nil)
				mustSet(t, token, jwt.IssuerKey, "https://other.example")
				return fixture.sign(t, token)
			},
		},
		{
			name: "audience不一致",
			token: func(t *testing.T) string {
				token := directToken(t, nil)
				mustSet(t, token, jwt.AudienceKey, []string{"other-service"})
				return fixture.sign(t, token)
			},
		},
		{
			name: "期限切れ",
			token: func(t *testing.T) string {
				token := directToken(t, nil)
				mustSet(t, token, jwt.ExpirationKey, verifierTestNow.Add(-time.Second))
				return fixture.sign(t, token)
			},
		},
		{
			name: "未来のiat",
			token: func(t *testing.T) string {
				token := directToken(t, nil)
				mustSet(t, token, jwt.IssuedAtKey, verifierTestNow.Add(time.Second))
				return fixture.sign(t, token)
			},
		},
		{
			name: "iatなし",
			token: func(t *testing.T) string {
				token := directToken(t, nil)
				mustRemove(t, token, jwt.IssuedAtKey)
				return fixture.sign(t, token)
			},
		},
		{
			name: "expなし",
			token: func(t *testing.T) string {
				token := directToken(t, nil)
				mustRemove(t, token, jwt.ExpirationKey)
				return fixture.sign(t, token)
			},
		},
		{
			name: "subjectなし",
			token: func(t *testing.T) string {
				token := directToken(t, nil)
				mustRemove(t, token, jwt.SubjectKey)
				return fixture.sign(t, token)
			},
		},
		{
			name: "optional claim型不正",
			token: func(t *testing.T) string {
				token := directToken(t, map[string]any{"email": 123})
				return fixture.sign(t, token)
			},
		},
		{
			name: "署名鍵不一致",
			token: func(t *testing.T) string {
				return wrongFixture.sign(t, directToken(t, nil))
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := verifier.Verify(context.Background(), test.token(t))
			if !errors.Is(err, ErrInvalidToken) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestExchangeVerifier(t *testing.T) {
	t.Parallel()

	fixture := newJWTFixture(t, "exchange-key")
	verifier, err := newExchangeVerifier(exchangeSettings(), fixture.source(), func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("verifierを作成できませんでした: %v", err)
	}
	identity, err := verifier.Verify(context.Background(), fixture.sign(t, exchangeToken(t, nil)))
	if err != nil {
		t.Fatalf("exchange tokenを検証できませんでした: %v", err)
	}
	if identity.Issuer != "https://issuer.example" || identity.Subject != "actor-subject" || identity.TokenScope == nil {
		t.Fatalf("identity=%+v", identity)
	}
	wantPermissions := []Permission{PermissionRead, PermissionManage}
	if !reflect.DeepEqual(identity.TokenScope.Permissions, wantPermissions) {
		t.Fatalf("permissions=%v; want %v", identity.TokenScope.Permissions, wantPermissions)
	}
}

func TestExchangeVerifierRejectsInvalidActorScopeAndLifetime(t *testing.T) {
	t.Parallel()

	fixture := newJWTFixture(t, "exchange-key")
	verifier, err := newExchangeVerifier(exchangeSettings(), fixture.source(), func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("verifierを作成できませんでした: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*testing.T, jwt.Token)
	}{
		{
			name: "actor issuer拒否",
			mutate: func(t *testing.T, token jwt.Token) {
				mustSet(t, token, "actor_issuer", "https://other.example")
			},
		},
		{
			name: "actor subjectなし",
			mutate: func(t *testing.T, token jwt.Token) {
				mustSet(t, token, "actor_sub", "")
			},
		},
		{
			name: "permissionなし",
			mutate: func(t *testing.T, token jwt.Token) {
				mustSet(t, token, "feedback_permissions", []string{})
			},
		},
		{
			name: "未知permission",
			mutate: func(t *testing.T, token jwt.Token) {
				mustSet(t, token, "feedback_permissions", []string{"feedback.owner"})
			},
		},
		{
			name: "tenantなし",
			mutate: func(t *testing.T, token jwt.Token) {
				mustRemove(t, token, "feedback_tenant")
			},
		},
		{
			name: "workspaceなし",
			mutate: func(t *testing.T, token jwt.Token) {
				mustSet(t, token, "feedback_workspace", "")
			},
		},
		{
			name: "最大lifetime超過",
			mutate: func(t *testing.T, token jwt.Token) {
				mustSet(t, token, jwt.ExpirationKey, verifierTestNow.Add(301*time.Second))
			},
		},
		{
			name: "lifetimeが非正数",
			mutate: func(t *testing.T, token jwt.Token) {
				mustSet(t, token, jwt.ExpirationKey, verifierTestNow)
			},
		},
		{
			name: "iatが31秒未来",
			mutate: func(t *testing.T, token jwt.Token) {
				mustSet(t, token, jwt.IssuedAtKey, verifierTestNow.Add(31*time.Second))
				mustSet(t, token, jwt.ExpirationKey, verifierTestNow.Add(120*time.Second))
			},
		},
		{
			name: "broker issuer不一致",
			mutate: func(t *testing.T, token jwt.Token) {
				mustSet(t, token, jwt.IssuerKey, "https://other-broker.example")
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			token := exchangeToken(t, nil)
			test.mutate(t, token)
			_, err := verifier.Verify(context.Background(), fixture.sign(t, token))
			if !errors.Is(err, ErrInvalidToken) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestVerifierRefreshesOnlyForUnknownKeyID(t *testing.T) {
	t.Parallel()

	oldFixture := newJWTFixture(t, "old-key")
	newFixture := newJWTFixture(t, "new-key")
	var calls []bool
	source := KeySetSourceFunc(func(_ context.Context, forceRefresh bool) (jwk.Set, error) {
		calls = append(calls, forceRefresh)
		if forceRefresh {
			return newFixture.publicSet, nil
		}
		return oldFixture.publicSet, nil
	})
	verifier, err := newDirectVerifier(directSettings(), source, func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("verifierを作成できませんでした: %v", err)
	}
	if _, err := verifier.Verify(context.Background(), newFixture.sign(t, directToken(t, nil))); err != nil {
		t.Fatalf("refresh後のtokenを検証できませんでした: %v", err)
	}
	if !reflect.DeepEqual(calls, []bool{false, true}) {
		t.Fatalf("key source calls=%v", calls)
	}
}

func TestVerifierRepresentsJWKSOutage(t *testing.T) {
	t.Parallel()

	source := KeySetSourceFunc(func(context.Context, bool) (jwk.Set, error) {
		return nil, errors.New("network unavailable")
	})
	fixture := newJWTFixture(t, "direct-key")
	verifier, err := newDirectVerifier(directSettings(), source, func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("verifierを作成できませんでした: %v", err)
	}
	_, err = verifier.Verify(context.Background(), fixture.sign(t, directToken(t, nil)))
	if !errors.Is(err, ErrJWKSUnavailable) {
		t.Fatalf("error=%v", err)
	}
}

func TestRemoteKeySetSourceCachesAndFailsClosed(t *testing.T) {
	t.Parallel()

	fixture := newJWTFixture(t, "remote-key")
	var requests atomic.Int32
	var unavailable atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		if unavailable.Load() {
			http.Error(writer, "unavailable", http.StatusServiceUnavailable)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(writer).Encode(fixture.publicSet); err != nil {
			t.Errorf("JWKSを書き込めませんでした: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	source, err := newRemoteKeySetSource(server.URL, server.Client(), time.Hour, func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("sourceを作成できませんでした: %v", err)
	}
	if _, err := source.KeySet(context.Background(), false); err != nil {
		t.Fatalf("JWKSを取得できませんでした: %v", err)
	}
	if _, err := source.KeySet(context.Background(), false); err != nil {
		t.Fatalf("cached JWKSを取得できませんでした: %v", err)
	}
	if requests.Load() != 1 {
		t.Fatalf("requests=%d; want 1", requests.Load())
	}
	unavailable.Store(true)
	if _, err := source.KeySet(context.Background(), true); !errors.Is(err, ErrJWKSUnavailable) {
		t.Fatalf("forced refresh error=%v", err)
	}
}

func directSettings() config.OIDCSettings {
	return config.OIDCSettings{
		Issuer:           "https://issuer.example",
		Audience:         "feedback-service",
		JWKSURL:          "https://issuer.example/.well-known/jwks.json",
		SubjectClaim:     "sub",
		DisplayNameClaim: "name",
		EmailClaim:       "email",
	}
}

func exchangeSettings() config.TokenExchangeSettings {
	return config.TokenExchangeSettings{
		Issuer:       "https://broker.example",
		Audience:     "feedback-service-exchange",
		JWKSURL:      "https://broker.example/.well-known/jwks.json",
		ActorIssuers: map[string]struct{}{"https://issuer.example": {}},
		MaxLifetime:  300 * time.Second,
	}
}

func directToken(t *testing.T, additional map[string]any) jwt.Token {
	t.Helper()
	token := jwt.New()
	mustSet(t, token, jwt.IssuerKey, "https://issuer.example")
	mustSet(t, token, jwt.AudienceKey, []string{"feedback-service"})
	mustSet(t, token, jwt.SubjectKey, "subject-a")
	mustSet(t, token, jwt.IssuedAtKey, verifierTestNow)
	mustSet(t, token, jwt.ExpirationKey, verifierTestNow.Add(5*time.Minute))
	for name, value := range additional {
		mustSet(t, token, name, value)
	}
	return token
}

func exchangeToken(t *testing.T, additional map[string]any) jwt.Token {
	t.Helper()
	token := jwt.New()
	mustSet(t, token, jwt.IssuerKey, "https://broker.example")
	mustSet(t, token, jwt.AudienceKey, []string{"feedback-service-exchange"})
	mustSet(t, token, jwt.SubjectKey, "exchange-token-id")
	mustSet(t, token, jwt.IssuedAtKey, verifierTestNow)
	mustSet(t, token, jwt.ExpirationKey, verifierTestNow.Add(120*time.Second))
	mustSet(t, token, "actor_issuer", "https://issuer.example/")
	mustSet(t, token, "actor_sub", "actor-subject")
	mustSet(t, token, "actor_name", "Actor")
	mustSet(t, token, "actor_email", "actor@example.test")
	mustSet(t, token, "feedback_tenant", "tenant-a")
	mustSet(t, token, "feedback_application", "app-a")
	mustSet(t, token, "feedback_environment", "prod")
	mustSet(t, token, "feedback_workspace", "workspace-a")
	mustSet(t, token, "feedback_permissions", []string{"feedback.manage", "feedback.read"})
	for name, value := range additional {
		mustSet(t, token, name, value)
	}
	return token
}

type jwtFixture struct {
	privateKey jwk.Key
	publicSet  jwk.Set
}

func newJWTFixture(t *testing.T, keyID string) jwtFixture {
	t.Helper()
	rawKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("RSA keyを生成できませんでした: %v", err)
	}
	privateKey, err := jwk.Import(rawKey)
	if err != nil {
		t.Fatalf("private JWKを生成できませんでした: %v", err)
	}
	publicKey, err := jwk.Import(&rawKey.PublicKey)
	if err != nil {
		t.Fatalf("public JWKを生成できませんでした: %v", err)
	}
	for _, key := range []jwk.Key{privateKey, publicKey} {
		if err := key.Set(jwk.KeyIDKey, keyID); err != nil {
			t.Fatalf("kidを設定できませんでした: %v", err)
		}
		if err := key.Set(jwk.AlgorithmKey, jwa.RS256()); err != nil {
			t.Fatalf("algを設定できませんでした: %v", err)
		}
	}
	set := jwk.NewSet()
	if err := set.AddKey(publicKey); err != nil {
		t.Fatalf("JWK setを生成できませんでした: %v", err)
	}
	return jwtFixture{privateKey: privateKey, publicSet: set}
}

func (fixture jwtFixture) source() KeySetSource {
	return KeySetSourceFunc(func(context.Context, bool) (jwk.Set, error) {
		return fixture.publicSet, nil
	})
}

func (fixture jwtFixture) sign(t *testing.T, token jwt.Token) string {
	t.Helper()
	signed, err := jwt.Sign(token, jwt.WithKey(jwa.RS256(), fixture.privateKey))
	if err != nil {
		t.Fatalf("JWTに署名できませんでした: %v", err)
	}
	return string(signed)
}

func signWithHMAC(t *testing.T, token jwt.Token) string {
	t.Helper()
	key := []byte(strings.Repeat("secret", 8))
	signed, err := jwt.Sign(token, jwt.WithKey(jwa.HS256(), key))
	if err != nil {
		t.Fatalf("HMAC JWTに署名できませんでした: %v", err)
	}
	return string(signed)
}

func unsignedToken(payload string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	body := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return header + "." + body + "."
}

func mustSet(t *testing.T, token jwt.Token, name string, value any) {
	t.Helper()
	if err := token.Set(name, value); err != nil {
		t.Fatalf("claim %sを設定できませんでした: %v", name, err)
	}
}

func mustRemove(t *testing.T, token jwt.Token, name string) {
	t.Helper()
	if err := token.Remove(name); err != nil {
		t.Fatalf("claim %sを削除できませんでした: %v", name, err)
	}
}
