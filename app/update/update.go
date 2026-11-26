package update

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-semver/semver"

	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/version"
)

type Channel string

// Beta follows the newest beta, or the stable release when that is newer.
const (
	Stable Channel = "stable"
	Beta   Channel = "beta"
)

// GitHub has an address for the latest stable release only, so the beta channel finds its
// release in BetaListURL. That list is GitHub's API, which answers 60 requests an hour for each
// network address. ReleaseFeedURL's {version} has no leading "v".
const (
	FeedURL        = "https://github.com/rclone/rclone-ui/releases/latest/download/" + FeedName
	ReleaseFeedURL = "https://github.com/rclone/rclone-ui/releases/download/v{version}/" + FeedName
	BetaListURL    = "https://api.github.com/repos/rclone/rclone-ui/releases?per_page=10"
)

const ReleasesList = "https://github.com/rclone/rclone-ui/releases"

const PortableNote = "This is a portable copy of Rclone UI, which doesn't update itself. Download the new release's portable zip, and replace rcui.exe, winfsp.msi and the bin folder with the ones in it. Your data folder and rclone.conf stay as they are."

// ReleasePage returns the page with the downloads of version, or ReleasesList when version is "".
func ReleasePage(version string) string {
	if version = strings.TrimPrefix(strings.TrimSpace(version), "v"); version == "" {
		return ReleasesList
	}
	return ReleasesList + "/tag/v" + url.PathEscape(version)
}

var (
	ErrNoRelease      = errs.New("no such release")
	ErrNoArtifact     = errs.New("the release has no download for this platform")
	ErrCantSelfUpdate = errs.New("this copy of Rclone UI can't update itself")
	ErrBadVersion     = errs.New("not an Rclone UI version, like 4.0.2")
	ErrFeedFormat     = errs.New("unknown feed format")
)

// CheckVersion returns an error unless v is a version that may be requested. That is "" (the
// channel's latest), or a semver version such as "4.0.2" or "v4.1.0-beta.1".
func CheckVersion(v string) error {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return nil
	}
	if _, err := semver.NewVersion(v); err != nil {
		return fmt.Errorf("%q is %w", v, ErrBadVersion)
	}
	return nil
}

// Options configure an Engine. The zero value means the stable channel's latest release, from the
// production feed, installed the same way this copy was installed.
type Options struct {
	// Channel is Stable when empty.
	Channel Channel
	// Version chooses a release ("4.0.2" or "v4.0.2") instead of the channel's latest. Check
	// refuses any version that CheckVersion refuses.
	Version string
	// Package is the artifact type: "" or "zip" for the install type's own, or "deb" or "rpm"
	// (Linux).
	Package string

	// Terminal means deb and rpm are installed through sudo rather than pkexec.
	Terminal bool
	// NoRelaunch means the Windows installer doesn't start the app when it is done.
	NoRelaunch bool

	// The rest are for tests and staging servers. Empty means the production value.
	FeedURL, BetaListURL, ReleaseFeedURL string
	HTTPClient                           *http.Client
	// CurrentVersion is the running version (version.App).
	CurrentVersion string
	// StagingDir is the folder in which each download gets its own folder (the temp folder).
	StagingDir string
	// Installed is how this copy was installed. Empty means it is detected from the running
	// executable.
	Installed InstallType
}

// Engine checks, downloads and installs one update. It isn't safe for concurrent use.
type Engine struct {
	opts Options

	detectOnce sync.Once
	installed  InstallType
	location   string
	blocked    i18n.Text
}

type installInfo struct {
	installed InstallType
	location  string
	blocked   i18n.Text
}

var detected = sync.OnceValue(func() installInfo {
	it, location, blocked := detectInstall()
	return installInfo{installed: it, location: location, blocked: blocked}
})

const responseHeaderTimeout = 30 * time.Second

var defaultClient = sync.OnceValue(func() *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.ResponseHeaderTimeout = responseHeaderTimeout
	return &http.Client{Transport: t}
})

func New(opts Options) *Engine {
	if opts.Channel == "" {
		opts.Channel = Stable
	}
	if opts.Package == "zip" {
		opts.Package = ""
	}
	opts.Version = strings.TrimPrefix(strings.TrimSpace(opts.Version), "v")
	if opts.FeedURL == "" {
		opts.FeedURL = FeedURL
	}
	if opts.BetaListURL == "" {
		opts.BetaListURL = BetaListURL
	}
	if opts.ReleaseFeedURL == "" {
		opts.ReleaseFeedURL = ReleaseFeedURL
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = defaultClient()
	}
	if opts.CurrentVersion == "" {
		opts.CurrentVersion = version.App
	}
	opts.CurrentVersion = strings.TrimPrefix(opts.CurrentVersion, "v")
	if opts.StagingDir == "" {
		opts.StagingDir = os.TempDir()
	}
	return &Engine{opts: opts, installed: opts.Installed}
}

// CurrentVersion returns the version this engine updates from, without a leading "v".
func (e *Engine) CurrentVersion() string { return e.opts.CurrentVersion }

// InstallType returns how this copy was installed, as detected from the running executable.
func (e *Engine) InstallType() InstallType {
	e.detect()
	return e.installed
}

// InstallLocation returns what an install replaces: the .app bundle, $APPIMAGE, the executable
// that a package owns, or the install folder on Windows. It returns "" when unknown.
func (e *Engine) InstallLocation() string {
	e.detect()
	return e.location
}

// CanSelfUpdate reports whether Install can replace this copy, and why not when it can't, in
// English, as the command line prints it.
func (e *Engine) CanSelfUpdate() (bool, string) {
	why := e.WhyNot()
	return why.IsZero(), why.String()
}

// WhyNot says why Install can't replace this copy, as a message that the UI shows in the app's
// language. It is the zero Text when Install can.
func (e *Engine) WhyNot() i18n.Text {
	e.detect()
	switch e.installed {
	case TypeFlatpak:
		return i18n.M("Rclone UI was installed from Flathub: update it through your software manager (or `flatpak update %s`).", platform.FlatpakAppID)
	case TypeUnmanaged:
		if e.location == "" {
			return i18n.M("No installer put this copy there, so it can't update itself. Download the latest release from %s.", ReleasesList)
		}
		// i18n: %[1]s is where Rclone UI runs from, and %[2]s the page of its releases.
		return i18n.M("No installer put %[1]s there, so it can't update itself. Download the latest release from %[2]s.", e.location, ReleasesList)
	case TypePortable:
		return i18n.M(PortableNote)
	}
	return e.blocked
}

func (e *Engine) detect() {
	e.detectOnce.Do(func() {
		if e.installed != "" {
			return
		}
		d := detected()
		e.installed, e.location, e.blocked = d.installed, d.location, d.blocked
	})
}
