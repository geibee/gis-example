package httpapi

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

const (
	corsAllowedMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
	corsAllowedHeaders = "Authorization, Content-Type, If-Match, Idempotency-Key, X-Request-ID"
	corsExposedHeaders = "ETag, X-Request-ID"
)

// CORSPolicyResolver はorigin allowlistだけを解決する最小PEP interfaceである。
type CORSPolicyResolver interface {
	IsOriginAllowed(context.Context, string) (bool, error)
}

// CORSPolicyResolverFunc は関数をCORSPolicyResolverとして利用可能にする。
type CORSPolicyResolverFunc func(context.Context, string) (bool, error)

func (resolver CORSPolicyResolverFunc) IsOriginAllowed(ctx context.Context, origin string) (bool, error) {
	return resolver(ctx, origin)
}

// ValidateOrigin はhttps originとローカル開発用http originだけを許可する。
func ValidateOrigin(raw string) (string, error) {
	if raw == "" || strings.TrimSpace(raw) != raw {
		return "", fmt.Errorf("originに空白を含められません")
	}
	origin, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("originを解析できません: %w", err)
	}
	hostname := origin.Hostname()
	localHTTP := origin.Scheme == "http" && (hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1")
	if strings.Contains(raw, "#") ||
		(origin.Scheme != "https" && !localHTTP) ||
		hostname == "" || origin.Host == "" || origin.Opaque != "" ||
		origin.User != nil || origin.Path != "" || origin.RawPath != "" ||
		origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" {
		return "", fmt.Errorf("originはhttps://host[:port]（ローカル開発だけhttp://localhost）で指定してください")
	}
	return raw, nil
}

// CORSMiddleware はDB由来allowlistをrequestごとに評価し、障害時はfail-closedにする。
func CORSMiddleware(resolver CORSPolicyResolver, logger *slog.Logger) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			rawOrigin := request.Header.Get("Origin")
			if rawOrigin == "" {
				next.ServeHTTP(writer, request)
				return
			}
			origin, err := ValidateOrigin(rawOrigin)
			if err != nil {
				WriteError(writer, request, NewAPIError(
					http.StatusForbidden,
					"/problems/cors.origin_invalid",
					"cors.origin_invalid",
					"originが不正です",
				))
				return
			}
			if resolver == nil {
				logger.ErrorContext(request.Context(), "CORS policy resolverが未設定です")
				WriteError(writer, request, errorsForUnavailableCORSPolicy())
				return
			}
			allowed, err := resolver.IsOriginAllowed(request.Context(), origin)
			if err != nil {
				logger.ErrorContext(request.Context(), "CORS policyを解決できません", slog.Any("error", err))
				WriteError(writer, request, errorsForUnavailableCORSPolicy())
				return
			}
			if !allowed {
				WriteError(writer, request, NewAPIError(
					http.StatusForbidden,
					"/problems/cors.origin_denied",
					"cors.origin_denied",
					"登録されていないoriginです",
				))
				return
			}

			writer.Header().Set("Access-Control-Allow-Origin", origin)
			appendVary(writer.Header(), "Origin")
			writer.Header().Set("Access-Control-Expose-Headers", corsExposedHeaders)
			if request.Method == http.MethodOptions {
				writer.Header().Set("Access-Control-Allow-Methods", corsAllowedMethods)
				writer.Header().Set("Access-Control-Allow-Headers", corsAllowedHeaders)
				writer.Header().Set("Access-Control-Max-Age", "600")
				writer.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(writer, request)
		})
	}
}

func errorsForUnavailableCORSPolicy() *APIError {
	return NewAPIError(http.StatusInternalServerError, "/problems/internal-error", "internal.error", "")
}

func appendVary(header http.Header, value string) {
	for _, line := range header.Values("Vary") {
		for _, existing := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(existing), value) {
				return
			}
		}
	}
	header.Add("Vary", value)
}
