package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/lestrrat-go/jwx/v3/jwk"
)

func TestAuthenticateSelectsSingleTrustBoundary(t *testing.T) {
	t.Parallel()

	directFixture := newJWTFixture(t, "direct-key")
	exchangeFixture := newJWTFixture(t, "exchange-key")
	directCalls := 0
	exchangeCalls := 0
	directSource := KeySetSourceFunc(func(context.Context, bool) (jwk.Set, error) {
		directCalls++
		return directFixture.publicSet, nil
	})
	exchangeSource := KeySetSourceFunc(func(context.Context, bool) (jwk.Set, error) {
		exchangeCalls++
		return exchangeFixture.publicSet, nil
	})
	directVerifier, err := newDirectVerifier(directSettings(), directSource, func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("direct verifierを作成できませんでした: %v", err)
	}
	exchangeVerifier, err := newExchangeVerifier(exchangeSettings(), exchangeSource, func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("exchange verifierを作成できませんでした: %v", err)
	}
	auditor := &denialAuditorStub{}
	authenticator, err := NewAuthenticator(
		directVerifier,
		exchangeVerifier,
		&principalResolverStub{principal: Principal{UserID: "user-id"}},
		auditor,
	)
	if err != nil {
		t.Fatalf("authenticatorを作成できませんでした: %v", err)
	}

	if _, err := authenticator.Authenticate(
		context.Background(),
		directFixture.sign(t, directToken(t, nil)),
		"direct-request",
	); err != nil {
		t.Fatalf("direct tokenを認証できませんでした: %v", err)
	}
	if directCalls != 1 || exchangeCalls != 0 {
		t.Fatalf("direct後のsource calls: direct=%d exchange=%d", directCalls, exchangeCalls)
	}

	if _, err := authenticator.Authenticate(
		context.Background(),
		exchangeFixture.sign(t, exchangeToken(t, nil)),
		"exchange-request",
	); err != nil {
		t.Fatalf("exchange tokenを認証できませんでした: %v", err)
	}
	if directCalls != 1 || exchangeCalls != 1 {
		t.Fatalf("exchange後のsource calls: direct=%d exchange=%d", directCalls, exchangeCalls)
	}
	if len(auditor.events) != 0 {
		t.Fatalf("成功したtrust boundary選択でdenial auditが記録されました: %+v", auditor.events)
	}
}

func TestAuthenticateAuditsUnknownIssuerExactlyOnce(t *testing.T) {
	t.Parallel()

	directFixture := newJWTFixture(t, "direct-key")
	exchangeFixture := newJWTFixture(t, "exchange-key")
	directCalls := 0
	exchangeCalls := 0
	directVerifier, err := newDirectVerifier(
		directSettings(),
		KeySetSourceFunc(func(context.Context, bool) (jwk.Set, error) {
			directCalls++
			return directFixture.publicSet, nil
		}),
		func() time.Time { return verifierTestNow },
	)
	if err != nil {
		t.Fatalf("direct verifierを作成できませんでした: %v", err)
	}
	exchangeVerifier, err := newExchangeVerifier(
		exchangeSettings(),
		KeySetSourceFunc(func(context.Context, bool) (jwk.Set, error) {
			exchangeCalls++
			return exchangeFixture.publicSet, nil
		}),
		func() time.Time { return verifierTestNow },
	)
	if err != nil {
		t.Fatalf("exchange verifierを作成できませんでした: %v", err)
	}
	auditor := &denialAuditorStub{}
	authenticator, err := NewAuthenticator(
		directVerifier,
		exchangeVerifier,
		&principalResolverStub{},
		auditor,
	)
	if err != nil {
		t.Fatalf("authenticatorを作成できませんでした: %v", err)
	}
	unknownIssuerToken := directToken(t, nil)
	mustSet(t, unknownIssuerToken, "iss", "https://unknown.example")
	_, err = authenticator.Authenticate(
		context.Background(),
		directFixture.sign(t, unknownIssuerToken),
		"unknown-request",
	)
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("error=%v", err)
	}
	if directCalls != 0 || exchangeCalls != 0 {
		t.Fatalf("unknown issuerでverifierを呼び出しました: direct=%d exchange=%d", directCalls, exchangeCalls)
	}
	if len(auditor.events) != 1 || auditor.events[0].RequestID != "unknown-request" {
		t.Fatalf("audit=%+v", auditor.events)
	}
}

func TestAuthenticatorResolvesOnlyVerifiedIdentity(t *testing.T) {
	t.Parallel()

	fixture := newJWTFixture(t, "direct-key")
	verifier, err := newDirectVerifier(directSettings(), fixture.source(), func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("verifierを作成できませんでした: %v", err)
	}
	resolver := &principalResolverStub{principal: Principal{UserID: "user-id"}}
	auditor := &denialAuditorStub{}
	authenticator, err := NewAuthenticator(verifier, nil, resolver, auditor)
	if err != nil {
		t.Fatalf("authenticatorを作成できませんでした: %v", err)
	}
	principal, err := authenticator.AuthenticateDirect(
		context.Background(),
		fixture.sign(t, directToken(t, map[string]any{"name": "利用者A"})),
		"request-id",
	)
	if err != nil {
		t.Fatalf("認証できませんでした: %v", err)
	}
	if principal.UserID != "user-id" || principal.Subject != "subject-a" || principal.Issuer != "https://issuer.example" {
		t.Fatalf("principal=%+v", principal)
	}
	if len(auditor.events) != 0 {
		t.Fatalf("成功時にdenial auditが記録されました: %+v", auditor.events)
	}
	if resolver.calls != 1 || resolver.identity.Subject != "subject-a" {
		t.Fatalf("resolver=%+v", resolver)
	}
}

func TestAuthenticatorAuditsInvalidTokenBeforeReturning(t *testing.T) {
	t.Parallel()

	fixture := newJWTFixture(t, "direct-key")
	verifier, err := newDirectVerifier(directSettings(), fixture.source(), func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("verifierを作成できませんでした: %v", err)
	}
	resolver := &principalResolverStub{}
	auditor := &denialAuditorStub{}
	authenticator, err := NewAuthenticator(verifier, nil, resolver, auditor)
	if err != nil {
		t.Fatalf("authenticatorを作成できませんでした: %v", err)
	}
	_, err = authenticator.AuthenticateDirect(context.Background(), "invalid", "request-a")
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("error=%v", err)
	}
	if resolver.calls != 0 {
		t.Fatal("未検証identityをresolverへ渡してはいけません")
	}
	if len(auditor.events) != 1 || auditor.events[0].Kind != DenialAuthentication || auditor.events[0].RequestID != "request-a" {
		t.Fatalf("audit=%+v", auditor.events)
	}
}

func TestAuthenticatorFailsClosedWhenAuditFails(t *testing.T) {
	t.Parallel()

	fixture := newJWTFixture(t, "direct-key")
	verifier, err := newDirectVerifier(directSettings(), fixture.source(), func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("verifierを作成できませんでした: %v", err)
	}
	authenticator, err := NewAuthenticator(
		verifier,
		nil,
		&principalResolverStub{},
		&denialAuditorStub{err: errors.New("audit database unavailable")},
	)
	if err != nil {
		t.Fatalf("authenticatorを作成できませんでした: %v", err)
	}
	_, err = authenticator.AuthenticateDirect(context.Background(), "invalid", "request-a")
	if !errors.Is(err, ErrAuditUnavailable) {
		t.Fatalf("error=%v", err)
	}
}

func TestDisabledExchangeIsAudited(t *testing.T) {
	t.Parallel()

	fixture := newJWTFixture(t, "direct-key")
	verifier, err := newDirectVerifier(directSettings(), fixture.source(), func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("verifierを作成できませんでした: %v", err)
	}
	auditor := &denialAuditorStub{}
	authenticator, err := NewAuthenticator(verifier, nil, &principalResolverStub{}, auditor)
	if err != nil {
		t.Fatalf("authenticatorを作成できませんでした: %v", err)
	}
	_, err = authenticator.AuthenticateExchange(context.Background(), "anything", "request-a")
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("error=%v", err)
	}
	if len(auditor.events) != 1 || auditor.events[0].ReasonCode != "auth.exchange_disabled" {
		t.Fatalf("audit=%+v", auditor.events)
	}
}

func TestRecordAuthenticationDenialRequiresAuditor(t *testing.T) {
	t.Parallel()

	if err := RecordAuthenticationDenial(context.Background(), nil, "request-a", "auth.required"); !errors.Is(err, ErrAuditUnavailable) {
		t.Fatalf("error=%v", err)
	}
}

func TestAuthenticatorRejectsAmbiguousTrustBoundary(t *testing.T) {
	t.Parallel()

	fixture := newJWTFixture(t, "key")
	directVerifier, err := newDirectVerifier(directSettings(), fixture.source(), func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("direct verifierを作成できませんでした: %v", err)
	}
	exchangeConfig := exchangeSettings()
	exchangeConfig.Issuer = directSettings().Issuer
	exchangeVerifier, err := newExchangeVerifier(exchangeConfig, fixture.source(), func() time.Time { return verifierTestNow })
	if err != nil {
		t.Fatalf("exchange verifierを作成できませんでした: %v", err)
	}
	if _, err := NewAuthenticator(
		directVerifier,
		exchangeVerifier,
		&principalResolverStub{},
		&denialAuditorStub{},
	); err == nil {
		t.Fatal("同じissuerを2つのtrust boundaryへ割り当ててはいけません")
	}
}

type principalResolverStub struct {
	principal Principal
	identity  Identity
	calls     int
	err       error
}

func (resolver *principalResolverStub) ResolvePrincipal(_ context.Context, identity Identity) (Principal, error) {
	resolver.calls++
	resolver.identity = identity
	return resolver.principal, resolver.err
}
