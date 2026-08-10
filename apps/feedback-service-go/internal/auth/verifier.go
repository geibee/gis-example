package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jws"
	"github.com/lestrrat-go/jwx/v3/jwt"
)

const (
	maxJWTBytes       = 64 * 1024
	exchangeClockSkew = 30 * time.Second
)

type DirectVerifier struct {
	settings config.OIDCSettings
	source   KeySetSource
	now      func() time.Time
}

type ExchangeVerifier struct {
	settings config.TokenExchangeSettings
	source   KeySetSource
	now      func() time.Time
}

func NewDirectVerifier(settings config.OIDCSettings, source KeySetSource) (*DirectVerifier, error) {
	return newDirectVerifier(settings, source, time.Now)
}

func newDirectVerifier(
	settings config.OIDCSettings,
	source KeySetSource,
	now func() time.Time,
) (*DirectVerifier, error) {
	if source == nil {
		return nil, fmt.Errorf("direct OIDC key sourceが未設定です")
	}
	if settings.Issuer == "" || settings.Audience == "" || settings.SubjectClaim == "" {
		return nil, fmt.Errorf("direct OIDC verifier設定が不足しています")
	}
	if now == nil {
		return nil, fmt.Errorf("clockが未設定です")
	}
	return &DirectVerifier{settings: settings, source: source, now: now}, nil
}

func NewExchangeVerifier(
	settings config.TokenExchangeSettings,
	source KeySetSource,
) (*ExchangeVerifier, error) {
	return newExchangeVerifier(settings, source, time.Now)
}

func newExchangeVerifier(
	settings config.TokenExchangeSettings,
	source KeySetSource,
	now func() time.Time,
) (*ExchangeVerifier, error) {
	if source == nil {
		return nil, fmt.Errorf("token exchange key sourceが未設定です")
	}
	if settings.Issuer == "" || settings.Audience == "" || len(settings.ActorIssuers) == 0 {
		return nil, fmt.Errorf("token exchange verifier設定が不足しています")
	}
	if settings.MaxLifetime < 30*time.Second || settings.MaxLifetime > 900*time.Second {
		return nil, fmt.Errorf("token exchange max lifetimeは30..900秒です")
	}
	if now == nil {
		return nil, fmt.Errorf("clockが未設定です")
	}
	return &ExchangeVerifier{settings: settings, source: source, now: now}, nil
}

// Verify は署名、algorithm、issuer、audience、時刻、subjectを検証する。
func (verifier *DirectVerifier) Verify(ctx context.Context, rawToken string) (Identity, error) {
	token, err := verifyJWT(ctx, rawToken, verifier.source)
	if err != nil {
		return Identity{}, err
	}
	now := verifier.now().UTC()
	if err := validateRegisteredClaims(token, verifier.settings.Issuer, verifier.settings.Audience, now, 0); err != nil {
		return Identity{}, err
	}
	subject, err := requiredStringClaim(token, verifier.settings.SubjectClaim)
	if err != nil {
		return Identity{}, err
	}
	email, err := optionalStringClaim(token, verifier.settings.EmailClaim)
	if err != nil {
		return Identity{}, err
	}
	displayName, err := optionalStringClaim(token, verifier.settings.DisplayNameClaim)
	if err != nil {
		return Identity{}, err
	}
	return Identity{
		Issuer:      verifier.settings.Issuer,
		Subject:     subject,
		Email:       email,
		DisplayName: displayName,
	}, nil
}

// Verify はbroker tokenに加えactor identity、resource scope、permission、lifetimeを検証する。
func (verifier *ExchangeVerifier) Verify(ctx context.Context, rawToken string) (Identity, error) {
	token, err := verifyJWT(ctx, rawToken, verifier.source)
	if err != nil {
		return Identity{}, err
	}
	now := verifier.now().UTC()
	if err := validateRegisteredClaims(
		token,
		verifier.settings.Issuer,
		verifier.settings.Audience,
		now,
		exchangeClockSkew,
	); err != nil {
		return Identity{}, err
	}
	issuedAt, hasIssuedAt := token.IssuedAt()
	expiresAt, hasExpiresAt := token.Expiration()
	if !hasIssuedAt || !hasExpiresAt {
		return Identity{}, invalidToken("iatまたはexpがありません", nil)
	}
	if !expiresAt.After(now) {
		return Identity{}, invalidToken("tokenは期限切れです", nil)
	}
	if issuedAt.After(now.Add(exchangeClockSkew)) {
		return Identity{}, invalidToken("iatが未来です", nil)
	}
	lifetime := expiresAt.Sub(issuedAt)
	if lifetime <= 0 || lifetime > verifier.settings.MaxLifetime {
		return Identity{}, invalidToken("token exchange lifetimeが不正です", nil)
	}

	actorIssuer, err := requiredStringClaim(token, "actor_issuer")
	if err != nil {
		return Identity{}, err
	}
	actorIssuer = strings.TrimRight(actorIssuer, "/")
	if _, allowed := verifier.settings.ActorIssuers[actorIssuer]; !allowed {
		return Identity{}, invalidToken("actor issuerが許可されていません", nil)
	}
	actorSubject, err := requiredStringClaim(token, "actor_sub")
	if err != nil {
		return Identity{}, err
	}
	actorEmail, err := optionalStringClaim(token, "actor_email")
	if err != nil {
		return Identity{}, err
	}
	actorName, err := optionalStringClaim(token, "actor_name")
	if err != nil {
		return Identity{}, err
	}
	permissionValues, err := requiredStringListClaim(token, "feedback_permissions")
	if err != nil {
		return Identity{}, err
	}
	permissions, err := ParsePermissions(permissionValues)
	if err != nil {
		return Identity{}, invalidToken("feedback_permissionsが不正です", err)
	}
	tenantKey, err := requiredStringClaim(token, "feedback_tenant")
	if err != nil {
		return Identity{}, err
	}
	applicationKey, err := requiredStringClaim(token, "feedback_application")
	if err != nil {
		return Identity{}, err
	}
	environmentKey, err := requiredStringClaim(token, "feedback_environment")
	if err != nil {
		return Identity{}, err
	}
	workspaceKey, err := requiredStringClaim(token, "feedback_workspace")
	if err != nil {
		return Identity{}, err
	}

	return Identity{
		Issuer:      actorIssuer,
		Subject:     actorSubject,
		Email:       actorEmail,
		DisplayName: actorName,
		TokenScope: &TokenScope{
			TenantKey:            tenantKey,
			ApplicationKey:       applicationKey,
			EnvironmentKey:       environmentKey,
			ExternalWorkspaceKey: workspaceKey,
			Permissions:          permissions,
		},
	}, nil
}

func verifyJWT(ctx context.Context, rawToken string, source KeySetSource) (jwt.Token, error) {
	if rawToken == "" || len(rawToken) > maxJWTBytes || strings.Count(rawToken, ".") != 2 {
		return nil, invalidToken("compact JWT形式ではありません", nil)
	}
	message, err := jws.Parse([]byte(rawToken))
	if err != nil {
		return nil, invalidToken("JWS headerを解析できません", err)
	}
	signatures := message.Signatures()
	if len(signatures) != 1 || signatures[0].ProtectedHeaders() == nil {
		return nil, invalidToken("署名は1件のprotected headerが必要です", nil)
	}
	header := signatures[0].ProtectedHeaders()
	algorithm, hasAlgorithm := header.Algorithm()
	if !hasAlgorithm || algorithm != jwa.RS256() {
		return nil, invalidToken("許可されていない署名algorithmです", nil)
	}
	keyID, hasKeyID := header.KeyID()
	if !hasKeyID || strings.TrimSpace(keyID) == "" {
		return nil, invalidToken("kidがありません", nil)
	}

	set, err := source.KeySet(ctx, false)
	if err != nil {
		return nil, normalizeJWKSError(err)
	}
	if set == nil {
		return nil, &JWKSUnavailableError{Err: fmt.Errorf("key sourceがnil setを返しました")}
	}
	key, found := set.LookupKeyID(keyID)
	if !found {
		set, err = source.KeySet(ctx, true)
		if err != nil {
			return nil, normalizeJWKSError(err)
		}
		if set == nil {
			return nil, &JWKSUnavailableError{Err: fmt.Errorf("key sourceがnil setを返しました")}
		}
		key, found = set.LookupKeyID(keyID)
		if !found {
			return nil, invalidToken("kidに対応する鍵がありません", nil)
		}
	}
	keyAlgorithm, hasKeyAlgorithm := key.Algorithm()
	if !hasKeyAlgorithm || keyAlgorithm.String() != jwa.RS256().String() {
		return nil, invalidToken("JWK algorithmが許可されていません", nil)
	}

	verified, err := jwt.Parse(
		[]byte(rawToken),
		jwt.WithContext(ctx),
		jwt.WithKeySet(set),
		jwt.WithValidate(false),
	)
	if err != nil {
		return nil, invalidToken("署名を検証できません", err)
	}
	return verified, nil
}

func validateRegisteredClaims(
	token jwt.Token,
	issuer string,
	audience string,
	now time.Time,
	skew time.Duration,
) error {
	options := []jwt.ValidateOption{
		jwt.WithIssuer(issuer),
		jwt.WithAudience(audience),
		jwt.WithRequiredClaim(jwt.IssuedAtKey),
		jwt.WithRequiredClaim(jwt.ExpirationKey),
		jwt.WithClock(jwt.ClockFunc(func() time.Time { return now })),
	}
	if skew > 0 {
		options = append(options, jwt.WithAcceptableSkew(skew))
	}
	if err := jwt.Validate(token, options...); err != nil {
		return invalidToken("issuer、audience、またはtime claimが不正です", err)
	}
	return nil
}

func requiredStringClaim(token jwt.Token, name string) (string, error) {
	if name == "sub" {
		value, ok := token.Subject()
		if !ok || strings.TrimSpace(value) == "" {
			return "", invalidToken(name+" claimがありません", nil)
		}
		return value, nil
	}
	if !token.Has(name) {
		return "", invalidToken(name+" claimがありません", nil)
	}
	var value string
	if err := token.Get(name, &value); err != nil || strings.TrimSpace(value) == "" {
		return "", invalidToken(name+" claimが文字列ではありません", err)
	}
	return value, nil
}

func optionalStringClaim(token jwt.Token, name string) (*string, error) {
	if name == "" || !token.Has(name) {
		return nil, nil
	}
	var value string
	if err := token.Get(name, &value); err != nil {
		return nil, invalidToken(name+" claimが文字列ではありません", err)
	}
	return &value, nil
}

func requiredStringListClaim(token jwt.Token, name string) ([]string, error) {
	if !token.Has(name) {
		return nil, invalidToken(name+" claimがありません", nil)
	}
	var rawValues []any
	if err := token.Get(name, &rawValues); err != nil || len(rawValues) == 0 {
		return nil, invalidToken(name+" claimが文字列配列ではありません", err)
	}
	values := make([]string, 0, len(rawValues))
	for _, rawValue := range rawValues {
		value, ok := rawValue.(string)
		if !ok {
			return nil, invalidToken(name+" claimが文字列配列ではありません", nil)
		}
		values = append(values, value)
	}
	return values, nil
}

func invalidToken(message string, cause error) error {
	if cause == nil {
		return fmt.Errorf("%w: %s", ErrInvalidToken, message)
	}
	return fmt.Errorf("%w: %s: %v", ErrInvalidToken, message, cause)
}

func normalizeJWKSError(err error) error {
	if err == nil {
		return nil
	}
	if errorsIsJWKSUnavailable(err) {
		return err
	}
	return &JWKSUnavailableError{Err: err}
}

func errorsIsJWKSUnavailable(err error) bool {
	return errors.Is(err, ErrJWKSUnavailable)
}
