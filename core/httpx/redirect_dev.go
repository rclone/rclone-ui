//go:build !production

package httpx

import (
	"net/http"
	"net/url"
	"os"
	"strings"
)

func devRedirect(rt http.RoundTripper) http.RoundTripper {
	to := map[string]*url.URL{}
	for pair := range strings.SplitSeq(os.Getenv("RCUI_DEV_REDIRECT"), ",") {
		host, target, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if u, err := url.Parse(target); ok && err == nil && u.Host != "" {
			to[host] = u
		}
	}
	if len(to) == 0 {
		return rt
	}
	return redirect{rt: rt, to: to}
}

type redirect struct {
	rt http.RoundTripper
	to map[string]*url.URL
}

func (r redirect) RoundTrip(req *http.Request) (*http.Response, error) {
	target, ok := r.to[req.URL.Hostname()]
	if !ok {
		return r.rt.RoundTrip(req)
	}
	out := req.Clone(req.Context())
	out.URL.Scheme, out.URL.Host, out.Host = target.Scheme, target.Host, target.Host
	return r.rt.RoundTrip(out)
}
