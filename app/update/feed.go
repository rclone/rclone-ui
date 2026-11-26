package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"time"

	"github.com/coreos/go-semver/semver"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

var (
	errPackageValue    = errors.New("--package should be one of zip|deb|rpm")
	errPackageNotLinux = errors.New(".deb and .rpm packages are supported only on Linux")
)

var checkTimeout = 30 * time.Second

var errFeedTimeout = errs.New("the update feed didn't answer within 30 seconds")

func withCheckTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeoutCause(ctx, checkTimeout, errFeedTimeout)
}

func feedTimedOut(ctx context.Context, err error) error {
	if err != nil && errors.Is(context.Cause(ctx), errFeedTimeout) {
		return errFeedTimeout
	}
	return err
}

const FeedFormat = 1

const FeedName = "rclone-ui-update.json"

type Feed struct {
	Format  int         `json:"format"`
	Release FeedRelease `json:"release"`
	// Files holds the release's files that an update installs, by FileKey.
	Files map[string]FeedFile `json:"files"`
	// Rclone is the rclone version included in the release ("v1.76.2").
	Rclone string `json:"rclone,omitempty"`
	Policy Policy `json:"policy"`
}

type FeedRelease struct {
	// Version has no leading "v".
	Version string `json:"version"`
	// Date is when the feed was written, in RFC 3339 format.
	Date  string `json:"date,omitempty"`
	Notes string `json:"notes,omitempty"`
}

type FeedFile struct {
	URL string `json:"url"`
}

// Policy says which running versions are too old. Empty fields set no limit.
type Policy struct {
	// Minimum is the oldest version that may still be used. An older one must update.
	Minimum string `json:"minimum,omitempty"`
	// Recommended is the oldest version that isn't offered the update at start.
	Recommended string `json:"recommended,omitempty"`
}

func FileKey(goos, goarch string, kind Kind) string {
	return goos + "-" + goarch + "-" + string(kind)
}

type Release struct {
	// Version has no leading "v".
	Version string
	// Rclone is the rclone version included in the release ("v1.76.2"), or "" when the feed
	// doesn't say.
	Rclone  string
	Notes   string
	PubDate time.Time
	Policy  Policy
	Channel Channel
	Current string
	Kind    Kind
	Key     string
	URL     string
}

// Newer reports whether the release is newer than the running version. A running version that
// isn't semver (a dev build) is older than any release.
func (r *Release) Newer() bool { return compareVersions(r.Version, r.Current) > 0 }

func (r *Release) Same() bool { return compareVersions(r.Version, r.Current) == 0 }

func (r *Release) Describe() string { return Describe(r.Version, r.Rclone) }

func Describe(appVersion, rcloneVersion string) string {
	if rcloneVersion == "" {
		return appVersion
	}
	return appVersion + " (rclone " + rcloneVersion + ")"
}

// CompareVersions compares two release versions and returns -1, 0 or 1. A leading "v" is
// ignored. A version that isn't semver (a dev build) is older than any release.
func CompareVersions(a, b string) int { return compareVersions(a, b) }

func compareVersions(a, b string) int {
	va, errA := semver.NewVersion(strings.TrimPrefix(a, "v"))
	vb, errB := semver.NewVersion(strings.TrimPrefix(b, "v"))
	switch {
	case errA == nil && errB == nil:
		return va.Compare(*vb)
	case errA == nil:
		return 1
	case errB == nil:
		return -1
	case a == b:
		return 0
	}
	return -1
}

// Check fetches the release that the options ask for. It reads the requested version's own feed,
// or the stable feed, or for the beta channel whichever of the beta and stable feeds has the
// newer release. It chooses this platform's artifact and fails with ErrNoArtifact when there is
// none. It gives up after 30 seconds. A version that CheckVersion refuses is refused before
// anything is fetched.
func (e *Engine) Check(ctx context.Context) (*Release, error) {
	if err := CheckVersion(e.opts.Version); err != nil {
		return nil, err
	}
	kind, err := e.artifactKind()
	if err != nil {
		return nil, err
	}
	ctx, cancel := withCheckTimeout(ctx)
	defer cancel()
	f, err := e.feed(ctx)
	if err != nil {
		return nil, feedTimedOut(ctx, err)
	}
	if e.opts.Version != "" && compareVersions(f.Release.Version, e.opts.Version) != 0 {
		return nil, errs.Errorf("the feed of Rclone UI %s describes %s", e.opts.Version, f.Release.Version)
	}
	return e.release(f, kind)
}

func (e *Engine) feed(ctx context.Context) (*Feed, error) {
	if e.opts.Version != "" {
		f, err := e.fetch(ctx, e.releaseFeedURL(e.opts.Version))
		if errors.Is(err, ErrNoRelease) {
			return nil, fmt.Errorf("Rclone UI %s: %w", e.opts.Version, ErrNoRelease)
		}
		return f, err
	}
	return e.latest(ctx, e.opts.Channel)
}

type noReleaseYet struct{ beta bool }

func (e noReleaseYet) Error() string { return e.Text().String() }
func (e noReleaseYet) Unwrap() error { return ErrNoRelease }

func (e noReleaseYet) Text() i18n.Text {
	if e.beta {
		return i18n.M("no stable or beta release of Rclone UI yet")
	}
	return i18n.M("no stable release of Rclone UI yet")
}

func (e *Engine) latest(ctx context.Context, ch Channel) (*Feed, error) {
	stable, err := e.fetch(ctx, e.opts.FeedURL)
	if ch != Beta {
		if errors.Is(err, ErrNoRelease) {
			return nil, noReleaseYet{}
		}
		return stable, err
	}
	if err != nil && !errors.Is(err, ErrNoRelease) {
		return nil, err
	}
	beta, betaErr := e.newestBeta(ctx)
	switch {
	case errors.Is(betaErr, ErrNoRelease), errors.Is(betaErr, errListLimited) && stable != nil:
		if stable == nil {
			return nil, noReleaseYet{beta: true}
		}
		return stable, nil
	case betaErr != nil:
		return nil, betaErr
	case stable == nil || compareVersions(beta.Release.Version, stable.Release.Version) >= 0:
		return beta, nil
	}
	return stable, nil
}

func (e *Engine) releaseFeedURL(version string) string {
	return strings.ReplaceAll(e.opts.ReleaseFeedURL, "{version}", url.PathEscape(version))
}

var errListLimited = errs.New("GitHub is answering no more requests from this network for now, so the newest beta can't be looked up. Try again in an hour.")

const maxList = 4 << 20

func (e *Engine) newestBeta(ctx context.Context) (*Feed, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.opts.BetaListURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", userAgent(e.opts.CurrentVersion))
	resp, err := e.opts.HTTPClient.Do(req)
	if err != nil {
		return nil, errs.Errorf("could not reach GitHub's list of releases: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == http.StatusTooManyRequests,
		resp.StatusCode == http.StatusForbidden && resp.Header.Get("X-RateLimit-Remaining") == "0":
		return nil, errListLimited
	case resp.StatusCode != http.StatusOK:
		return nil, errs.Errorf("GitHub's list of releases answered %s (%s)", resp.Status, e.opts.BetaListURL)
	}
	var list []struct {
		Tag        string `json:"tag_name"`
		Prerelease bool   `json:"prerelease"`
		Draft      bool   `json:"draft"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxList)).Decode(&list); err != nil {
		return nil, errs.Errorf("GitHub's list of releases isn't valid (%s): %w", e.opts.BetaListURL, err)
	}
	newest := ""
	for _, r := range list {
		version, ok := strings.CutPrefix(r.Tag, "v")
		if !ok || !r.Prerelease || r.Draft {
			continue
		}
		if v, err := semver.NewVersion(version); err != nil || v.PreRelease == "" {
			continue
		}
		if newest == "" || compareVersions(version, newest) > 0 {
			newest = version
		}
	}
	if newest == "" {
		return nil, fmt.Errorf("%s: no beta: %w", e.opts.BetaListURL, ErrNoRelease)
	}
	f, err := e.fetch(ctx, e.releaseFeedURL(newest))
	if err != nil {
		return nil, err
	}
	if compareVersions(f.Release.Version, newest) != 0 {
		return nil, errs.Errorf("the feed of Rclone UI %s describes %s", newest, f.Release.Version)
	}
	return f, nil
}

const maxFeed = 1 << 20

func (e *Engine) fetch(ctx context.Context, url string) (*Feed, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent(e.opts.CurrentVersion))
	resp, err := e.opts.HTTPClient.Do(req)
	if err != nil {
		return nil, errs.Errorf("could not reach the update feed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, fmt.Errorf("%s: %w", url, ErrNoRelease)
	case resp.StatusCode != http.StatusOK:
		return nil, errs.Errorf("the update feed answered %s (%s)", resp.Status, url)
	}
	var f Feed
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxFeed)).Decode(&f); err != nil {
		return nil, errs.Errorf("the update feed isn't valid (%s): %w", url, err)
	}
	if f.Format != FeedFormat {
		return nil, errs.Errorf("%w: the update feed is in format %d, and this Rclone UI reads format %d. Download the latest release from %s",
			ErrFeedFormat, f.Format, FeedFormat, ReleasesList)
	}
	v := strings.TrimPrefix(strings.TrimSpace(f.Release.Version), "v")
	if _, err := semver.NewVersion(v); err != nil {
		return nil, errs.Errorf("the update feed names no valid version (%s): %q", url, f.Release.Version)
	}
	f.Release.Version = v
	return &f, nil
}

func (e *Engine) release(f *Feed, kind Kind) (*Release, error) {
	r := &Release{
		Version: f.Release.Version,
		Rclone:  f.Rclone,
		Notes:   f.Release.Notes,
		Policy:  f.Policy,
		Channel: e.opts.Channel,
		Current: e.opts.CurrentVersion,
		Kind:    kind,
	}
	if t, err := time.Parse(time.RFC3339, f.Release.Date); err == nil {
		r.PubDate = t
	}
	key := FileKey(runtime.GOOS, runtime.GOARCH, kind)
	p, ok := f.Files[key]
	if !ok || p.URL == "" {
		return nil, fmt.Errorf("Rclone UI %s, %s: %w", f.Release.Version, key, ErrNoArtifact)
	}
	r.Key, r.URL = key, p.URL
	return r, nil
}

func userAgent(current string) string {
	return "rclone-ui/" + current + " (" + runtime.GOOS + "; " + runtime.GOARCH + ")"
}
