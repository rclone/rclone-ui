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

// checkTimeout limits a check of the feed. It is a variable so that tests can change it.
var checkTimeout = 30 * time.Second

var errFeedTimeout = errs.New("the update feed didn't answer within 30 seconds")

// withCheckTimeout limits one check to checkTimeout. feedTimedOut then reports the timeout in its
// error.
func withCheckTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeoutCause(ctx, checkTimeout, errFeedTimeout)
}

// feedTimedOut returns errFeedTimeout when ctx ran out of time for its check, or else err.
func feedTimedOut(ctx context.Context, err error) error {
	if err != nil && errors.Is(context.Cause(ctx), errFeedTimeout) {
		return errFeedTimeout
	}
	return err
}

// FeedFormat is the format of the feed that this build reads. A feed in another format is refused,
// so a future format can change anything.
const FeedFormat = 1

// FeedName is the feed's file name. Each release carries its own copy. The stable channel reads
// the copy on GitHub's latest release, and the beta channel the copy on the newest beta (FeedURL).
const FeedName = "rclone-ui-update.json"

// Feed is rclone-ui-update.json, which build/release writes. It describes one release.
type Feed struct {
	// Format is FeedFormat.
	Format  int         `json:"format"`
	Release FeedRelease `json:"release"`
	// Files holds the release's files that an update installs, by FileKey.
	Files map[string]FeedFile `json:"files"`
	// Rclone is the rclone version included in the release ("v1.76.2").
	Rclone string `json:"rclone,omitempty"`
	// Policy says which running versions must or should update. It is the same in every feed
	// written at the same time (build/release/policy.json).
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

// FileKey returns the feed key of the file of kind for goos/goarch, such as "darwin-arm64-app".
func FileKey(goos, goarch string, kind Kind) string {
	return goos + "-" + goarch + "-" + string(kind)
}

// Release is one release on a channel, with the artifact for this platform already chosen.
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
	// Current is the running version.
	Current string
	// Kind is the artifact's kind, and Key is its FileKey.
	Kind Kind
	Key  string
	URL  string
}

// Newer reports whether the release is newer than the running version. A running version that
// isn't semver (a dev build) is older than any release.
func (r *Release) Newer() bool { return compareVersions(r.Version, r.Current) > 0 }

func (r *Release) Same() bool { return compareVersions(r.Version, r.Current) == 0 }

// Describe returns "4.0.2 (rclone v1.76.2)", or "4.0.2" when the feed doesn't give the rclone
// version.
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

// compareVersions compares in semver order. A version that doesn't parse sorts below every
// version that does. Two versions that don't parse are only checked for equality, as strings.
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

// noReleaseYet is ErrNoRelease for a channel that has had no release yet. beta is set when
// neither the stable nor the beta channel has one.
type noReleaseYet struct{ beta bool }

func (e noReleaseYet) Error() string { return e.Text().String() }
func (e noReleaseYet) Unwrap() error { return ErrNoRelease }

// Text returns the error's message, which the UI shows in the app's language.
func (e noReleaseYet) Text() i18n.Text {
	if e.beta {
		return i18n.M("no stable or beta release of Rclone UI yet")
	}
	return i18n.M("no stable release of Rclone UI yet")
}

// latest returns the newest release on a channel. Either may not exist yet: a beta before the
// first one, and the stable feed before the first stable release. The beta channel then takes
// the other one. It also takes the stable release when GitHub won't list the betas for now
// (errListLimited). A noReleaseYet error means the channel has no release at all.
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

// errListLimited means GitHub answers no more requests from this network address for now. Its
// API allows 60 an hour for each address, which other programs on the same network share.
var errListLimited = errs.New("GitHub is answering no more requests from this network for now, so the newest beta can't be looked up. Try again in an hour.")

// maxList limits the size of GitHub's list of releases. It is a few hundred kilobytes: each
// release lists all of its files.
const maxList = 4 << 20

// newestBeta returns the feed of the newest beta. A beta is a pre-release on GitHub whose tag is
// a version with a pre-release part, such as v4.1.0-beta.1 (the release-beta workflow). The
// newest one is looked up in GitHub's list of the newest releases (BetaListURL), and its own
// feed is read. ErrNoRelease means the list has no beta.
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

// maxFeed limits the size of a feed. A real one is a few kilobytes.
const maxFeed = 1 << 20

// fetch reads one feed. A 404 returns ErrNoRelease, and a feed in another format is refused.
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

// release chooses the artifact of the given kind for this platform from f.
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
