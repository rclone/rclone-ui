package httpx

import (
	"net"
	"net/http"
	"time"
)

const connectTimeout = 10 * time.Second

func New(timeout time.Duration) *http.Client {
	return &http.Client{Transport: devRedirect(baseTransport()), Timeout: timeout}
}

func baseTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: connectTimeout, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
}
