package telemetry

import (
	"context"
	"regexp"

	"github.com/rclone/rclone-ui/core/internal/late"
)

// reName is an error's kind or a window's name: letters and digits, as in "TypeError" and
// "Commander".
var reName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,40}$`)

type API struct {
	s *late.Value[*Service]
}

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// Track sends a page's event (pageEvents). It is refused when it isn't one of them.
func (a *API) Track(ctx context.Context, event string, props map[string]any) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Track(event, props) })
}

// PageError reports an error that a page didn't handle, in the window named window. name is the
// error's kind ("TypeError"), and stack is its stack as the browser wrote it.
func (a *API) PageError(ctx context.Context, window, name, message, stack string) error {
	return a.s.Do(ctx, func(s *Service) error {
		// Both come from the page, so only a plain name is taken: no free text.
		if !reName.MatchString(name) {
			name = "Error"
		}
		if !reName.MatchString(window) {
			window = ""
		}
		s.Report(Crash{Kind: name, Message: message, Frames: scriptFrames(stack), Source: "page", Window: window})
		return nil
	})
}

func (a *API) Info(ctx context.Context) (Info, error) {
	return late.Call(ctx, a.s, func(s *Service) (Info, error) { return s.Info(), nil })
}
