package media

import (
	"context"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/late"
)

// SignedURL is a URL that a page can load a file from without any other credential.
type SignedURL struct {
	// URL is on the media server's port: http://127.0.0.1:port/media?…
	URL string `json:"url"`
	// ExpiresAt is when the URL stops working, in ms since the epoch.
	ExpiresAt int64 `json:"expiresAt"`
}

type API struct{ s *late.Value[*Signer] }

func NewAPI(s *late.Value[*Signer]) *API { return &API{s: s} }

// SignURL signs a URL for the file at path. With inline the file is shown, otherwise it is
// downloaded.
func (a *API) SignURL(ctx context.Context, path string, inline bool) (SignedURL, error) {
	return late.Call(ctx, a.s, func(s *Signer) (SignedURL, error) {
		if path == "" {
			return SignedURL{}, errs.Invalid(i18n.M("Name the file."), errs.Violation("path", "missing"))
		}
		u, exp := s.Sign(path, inline)
		return SignedURL{URL: u, ExpiresAt: exp.UnixMilli()}, nil
	})
}
