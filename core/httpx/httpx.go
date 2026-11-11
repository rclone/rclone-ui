// Package httpx creates the core's own outgoing HTTP clients (for notifications and link
// resolution). They use the same proxy as rclone and the children: the one in the process
// environment. The core sets it from Settings › Proxy before its first request (in rclone.Init),
// and Go reads it only once. So a change to the setting applies to all of them at once, after the
// app restarts. When no proxy is saved, the proxy from the environment that the app started in
// applies.
package httpx

import (
	"net"
	"net/http"
	"time"
)

// connectTimeout limits how long dialing takes, whatever the request's own timeout.
const connectTimeout = 10 * time.Second

// New creates a client that uses the environment's proxy. The hosts in NO_PROXY and loopback
// addresses are reached directly. timeout limits a whole exchange. 0 means no limit, for a reply
// that the caller streams.
func New(timeout time.Duration) *http.Client {
	return &http.Client{Transport: devRedirect(baseTransport()), Timeout: timeout}
}

// baseTransport returns a copy of net/http's default transport with a shorter connect timeout.
// It is built here rather than cloned, because http.DefaultTransport is a variable that any
// library may replace.
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
