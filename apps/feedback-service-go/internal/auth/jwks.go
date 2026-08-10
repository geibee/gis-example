package auth

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/lestrrat-go/jwx/v3/jwk"
)

const defaultJWKSTTL = 24 * time.Hour

// KeySetSource はJWT verifierから鍵取得と明示refreshを分離するportである。
type KeySetSource interface {
	KeySet(context.Context, bool) (jwk.Set, error)
}

type KeySetSourceFunc func(context.Context, bool) (jwk.Set, error)

func (source KeySetSourceFunc) KeySet(ctx context.Context, forceRefresh bool) (jwk.Set, error) {
	return source(ctx, forceRefresh)
}

// RemoteKeySetSource は検証済み設定URLだけを取得し、成功したJWKSを一定時間保持する。
type RemoteKeySetSource struct {
	url        string
	httpClient *http.Client
	ttl        time.Duration
	now        func() time.Time

	mutex     sync.Mutex
	set       jwk.Set
	fetchedAt time.Time
}

func NewRemoteKeySetSource(jwksURL string, httpClient *http.Client) (*RemoteKeySetSource, error) {
	return newRemoteKeySetSource(jwksURL, httpClient, defaultJWKSTTL, time.Now)
}

func newRemoteKeySetSource(
	jwksURL string,
	httpClient *http.Client,
	ttl time.Duration,
	now func() time.Time,
) (*RemoteKeySetSource, error) {
	if jwksURL == "" {
		return nil, fmt.Errorf("JWKS URLが未設定です")
	}
	if ttl <= 0 {
		return nil, fmt.Errorf("JWKS cache TTLは正数で指定してください")
	}
	if now == nil {
		return nil, fmt.Errorf("clockが未設定です")
	}
	if httpClient == nil {
		httpClient = jwk.DefaultHTTPClient()
	} else {
		httpClient = jwk.WrapHTTPClientDefaults(httpClient)
	}
	return &RemoteKeySetSource{
		url:        jwksURL,
		httpClient: httpClient,
		ttl:        ttl,
		now:        now,
	}, nil
}

func (source *RemoteKeySetSource) KeySet(ctx context.Context, forceRefresh bool) (jwk.Set, error) {
	source.mutex.Lock()
	defer source.mutex.Unlock()

	if !forceRefresh && source.set != nil && source.now().Sub(source.fetchedAt) < source.ttl {
		return source.set, nil
	}
	set, err := jwk.Fetch(ctx, source.url, jwk.WithHTTPClient(source.httpClient))
	if err != nil {
		return nil, &JWKSUnavailableError{URL: source.url, Err: err}
	}
	if set.Len() == 0 {
		return nil, &JWKSUnavailableError{URL: source.url, Err: fmt.Errorf("JWKSに鍵がありません")}
	}
	source.set = set
	source.fetchedAt = source.now()
	return set, nil
}

// Ready は有効なcacheがあるか、JWKSを取得できる場合だけ成功する。
func (source *RemoteKeySetSource) Ready(ctx context.Context) error {
	_, err := source.KeySet(ctx, false)
	return err
}
