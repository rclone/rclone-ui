package linkresolve

import (
	"context"
	"errors"

	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/logs"
)

// Miss is why a lookup gave no file for an address that should have one.
type Miss string

const (
	// MissNothing means the service found no file behind the page: it answered with nothing, with
	// an error of its own (as it does for a link that it can't read), or with something that
	// can't be used.
	MissNothing Miss = "nothing"
	// MissUnreachable means the service gave no answer: no connection, or no answer in time.
	MissUnreachable Miss = "unreachable"
)

// Resolved is the media behind a page address. Found is false when there is none. For a page of
// one of Sites, Miss then says why, and the Download page warns, because a download would save
// the page itself. For any other address Miss is "": it is a file's own address, which is never
// looked up and is downloaded as it is.
type Resolved struct {
	Found    bool   `json:"found"`
	Miss     Miss   `json:"miss"`
	URL      string `json:"url"`
	Filename string `json:"filename"`
	Type     Kind   `json:"type"`
}

type API struct{ r *late.Value[*Resolver] }

func NewAPI(r *late.Value[*Resolver]) *API { return &API{r: r} }

// Resolve finds the media behind a page address. A lookup that fails is not an error: it is a
// miss, which the page words for the user, and its cause goes to the log.
func (a *API) Resolve(ctx context.Context, url string) (Resolved, error) {
	return late.Call(ctx, a.r, func(r *Resolver) (Resolved, error) {
		link, err := r.Resolve(ctx, url)
		switch {
		case err != nil && ctx.Err() != nil:
			return Resolved{}, ctx.Err() // the page asked for another address meanwhile
		case err != nil:
			miss := MissNothing
			if errors.Is(err, ErrNoAnswer) {
				miss = MissUnreachable
			}
			// The address isn't logged: it may name a private post.
			logs.Logger(logs.CompApp, "links").WarnContext(ctx, "looking up a link failed", "error", err)
			return Resolved{Miss: miss}, nil
		case link == nil && Listed(url):
			return Resolved{Miss: MissNothing}, nil
		case link == nil:
			return Resolved{}, nil
		}
		return Resolved{Found: true, URL: link.URL, Filename: link.Filename, Type: link.Type}, nil
	})
}

func (a *API) Sites() []Site { return Sites() }
