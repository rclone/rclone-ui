//go:build production

package httpx

import "net/http"

// devRedirect is only for development runs (see redirect_dev.go).
func devRedirect(rt http.RoundTripper) http.RoundTripper { return rt }
