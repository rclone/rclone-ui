//go:build production

package httpx

import "net/http"

func devRedirect(rt http.RoundTripper) http.RoundTripper { return rt }
