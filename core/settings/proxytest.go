package settings

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

const badProxyURL = "must be an http://, https:// or socks5:// URL with a host"

// proxyProbe is the address TestProxy requests. It returns a small response quickly from
// anywhere. TestProxy requests only this one address, so a dead proxy costs a single timeout.
const proxyProbe = "https://www.cloudflare.com/cdn-cgi/trace"

// TestProxy makes one request through proxyURL and describes the response.
func TestProxy(ctx context.Context, proxyURL string) (string, error) {
	u, err := url.Parse(proxyURL)
	if err != nil || u.Host == "" {
		return "", invalid(errs.Field("url", badProxyURL))
	}
	// Close the connection after the request. The transport has no IdleConnTimeout, so
	// otherwise every test would leave a connection to the proxy open while the core runs.
	tr := &http.Transport{Proxy: http.ProxyURL(u)}
	defer tr.CloseIdleConnections()
	client := &http.Client{Timeout: 10 * time.Second, Transport: tr}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, proxyProbe, nil)
	if err != nil {
		return "", err
	}
	res, err := client.Do(req)
	if err != nil {
		// i18n: The address that was requested through the proxy, then the error, in English.
		return "", errs.Said(errs.CodeFailed, i18n.M("request to %s failed: %s", proxyProbe, err.Error()))
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 200))
	if res.StatusCode != http.StatusOK {
		// i18n: The address that was requested through the proxy, then the HTTP status, such as "407 Proxy Authentication Required".
		return "", errs.Said(errs.CodeFailed, i18n.M("%s responded with status %s", proxyProbe, res.Status))
	}
	// i18n: The address that was requested through the proxy, then the start of its answer.
	return i18n.T("Connected via proxy. Endpoint: %s. Snippet: %s", proxyProbe, body), nil
}
