package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/lestrrat-go/jwx/v3/jwt"
)

type Authenticator struct {
	direct   *DirectVerifier
	exchange *ExchangeVerifier
	resolver PrincipalResolver
	auditor  DenialAuditor
}

func NewAuthenticator(
	direct *DirectVerifier,
	exchange *ExchangeVerifier,
	resolver PrincipalResolver,
	auditor DenialAuditor,
) (*Authenticator, error) {
	if direct == nil {
		return nil, fmt.Errorf("direct verifierが未設定です")
	}
	if resolver == nil {
		return nil, fmt.Errorf("principal resolverが未設定です")
	}
	if auditor == nil {
		return nil, fmt.Errorf("denial auditorが未設定です")
	}
	if exchange != nil && exchange.settings.Issuer == direct.settings.Issuer {
		return nil, fmt.Errorf("direct OIDCとtoken exchangeのissuerは分離してください")
	}
	return &Authenticator{direct: direct, exchange: exchange, resolver: resolver, auditor: auditor}, nil
}

// Authenticate は未検証issをverifier選択にだけ使い、選択したtrust boundaryで完全検証する。
// direct失敗後にexchangeを試すfirst-success方式にはせず、最終的な拒否だけを1回監査する。
func (authenticator *Authenticator) Authenticate(
	ctx context.Context,
	rawToken string,
	requestID string,
) (Principal, error) {
	issuer, err := unverifiedIssuer(rawToken)
	if err != nil {
		return authenticator.denyAuthentication(ctx, requestID, err)
	}
	var identity Identity
	switch {
	case issuer == authenticator.direct.settings.Issuer:
		identity, err = authenticator.direct.Verify(ctx, rawToken)
	case authenticator.exchange != nil && issuer == authenticator.exchange.settings.Issuer:
		identity, err = authenticator.exchange.Verify(ctx, rawToken)
	default:
		err = invalidToken("issuerに対応するtrust boundaryがありません", nil)
	}
	if err != nil {
		return authenticator.denyAuthentication(ctx, requestID, err)
	}
	return authenticator.resolve(ctx, identity)
}

func (authenticator *Authenticator) AuthenticateDirect(
	ctx context.Context,
	rawToken string,
	requestID string,
) (Principal, error) {
	identity, err := authenticator.direct.Verify(ctx, rawToken)
	if err != nil {
		return authenticator.denyAuthentication(ctx, requestID, err)
	}
	return authenticator.resolve(ctx, identity)
}

func (authenticator *Authenticator) AuthenticateExchange(
	ctx context.Context,
	rawToken string,
	requestID string,
) (Principal, error) {
	if authenticator.exchange == nil {
		err := invalidToken("token exchangeは無効です", nil)
		if auditErr := RecordAuthenticationDenial(ctx, authenticator.auditor, requestID, "auth.exchange_disabled"); auditErr != nil {
			return Principal{}, auditErr
		}
		return Principal{}, err
	}
	identity, err := authenticator.exchange.Verify(ctx, rawToken)
	if err != nil {
		return authenticator.denyAuthentication(ctx, requestID, err)
	}
	return authenticator.resolve(ctx, identity)
}

func (authenticator *Authenticator) denyAuthentication(
	ctx context.Context,
	requestID string,
	cause error,
) (Principal, error) {
	if auditErr := RecordAuthenticationDenial(ctx, authenticator.auditor, requestID, authenticationReason(cause)); auditErr != nil {
		return Principal{}, auditErr
	}
	return Principal{}, cause
}

func (authenticator *Authenticator) resolve(ctx context.Context, identity Identity) (Principal, error) {
	principal, err := authenticator.resolver.ResolvePrincipal(ctx, identity)
	if err != nil {
		return Principal{}, fmt.Errorf("principalの解決に失敗しました: %w", err)
	}
	// token由来のidentity/scopeをresolver実装が緩められないよう、検証済み値で固定する。
	principal.Issuer = identity.Issuer
	principal.Subject = identity.Subject
	principal.Email = identity.Email
	principal.DisplayName = identity.DisplayName
	principal.TokenScope = identity.TokenScope
	return principal, nil
}

// RecordAuthenticationDenial はAuthorization header欠落を含む401監査にも利用する。
func RecordAuthenticationDenial(
	ctx context.Context,
	auditor DenialAuditor,
	requestID string,
	reasonCode string,
) error {
	if auditor == nil {
		return &AuditUnavailableError{Err: fmt.Errorf("denial auditorが未設定です")}
	}
	if reasonCode == "" {
		reasonCode = "auth.required"
	}
	if err := auditor.RecordDenial(ctx, DenialEvent{
		Kind:       DenialAuthentication,
		RequestID:  requestID,
		Action:     "authenticate",
		ReasonCode: reasonCode,
	}); err != nil {
		return &AuditUnavailableError{Err: err}
	}
	return nil
}

func authenticationReason(err error) string {
	if errors.Is(err, ErrJWKSUnavailable) {
		return "auth.jwks_unavailable"
	}
	return "auth.invalid_token"
}

func unverifiedIssuer(rawToken string) (string, error) {
	if rawToken == "" || len(rawToken) > maxJWTBytes {
		return "", invalidToken("issuerを読み取れません", nil)
	}
	token, err := jwt.ParseInsecure([]byte(rawToken))
	if err != nil {
		return "", invalidToken("issuerを読み取れません", err)
	}
	issuer, ok := token.Issuer()
	if !ok || issuer == "" {
		return "", invalidToken("issuerがありません", nil)
	}
	return issuer, nil
}
