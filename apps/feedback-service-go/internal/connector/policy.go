package connector

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

type Resolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

type EndpointPolicy struct {
	AllowedHosts        map[string]struct{}
	AllowLocalHTTP      bool
	AllowPrivateNetwork bool
	Resolver            Resolver
}

func (p EndpointPolicy) Validate(ctx context.Context, raw string) (*url.URL, error) {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return nil, errors.New("connector endpointが不正です")
	}
	if endpoint.Scheme != "https" && !(p.AllowLocalHTTP && endpoint.Scheme == "http") {
		return nil, errors.New("connector endpointはhttpsで指定してください")
	}
	host := strings.ToLower(endpoint.Hostname())
	if p.AllowedHosts != nil {
		if _, ok := p.AllowedHosts[host]; !ok {
			return nil, errors.New("connector endpoint hostはallowlistにありません")
		}
	}
	resolver := p.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	addresses, err := resolver.LookupIPAddr(ctx, host)
	if err != nil || len(addresses) == 0 {
		return nil, fmt.Errorf("connector endpoint hostを解決できません: %w", err)
	}
	for _, address := range addresses {
		if unsafeIP(address.IP) && !p.AllowPrivateNetwork && !p.AllowLocalHTTP {
			return nil, errors.New("private/local connector endpointは許可されていません")
		}
	}
	return endpoint, nil
}

func unsafeIP(ip net.IP) bool {
	return ip.IsUnspecified() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsPrivate() || ip.IsMulticast()
}

func ValidateInternalURL(raw string, allowLocalHTTP bool) error {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return errors.New("connector URLが不正です")
	}
	host := endpoint.Hostname()
	local := endpoint.Scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
	if endpoint.Scheme != "https" && !local && !(allowLocalHTTP && endpoint.Scheme == "http") {
		return errors.New("connector URLはHTTPSで指定してください")
	}
	return nil
}
