// Package update is Rclone UI's update engine. It reads the feed (rclone-ui-update.json, see Feed),
// downloads releases and installs them for each install type.
//
// The engine has two front ends: the UI role's update flow, with dialogs and progress in a window,
// and `rcui update` (see cli.go), with text and progress on stdout. It never imports Wails.
//
// # What the UI flow calls, in order
//
//  1. e := update.New(update.Options{Channel: ch, Version: v}), with the user's channel, or with
//     the version and channel from an update link ("" for either means the default). `rcui
//     update` passes the running app an rclone://update link through its single-instance lock.
//  2. ok, why := e.CanSelfUpdate(). It returns false under Flatpak (which updates through the
//     software manager), for a copy that no installer put there, for a portable copy, and for an
//     app run from its disk image or a translocated path. In that case, show why and stop. A
//     portable copy still checks for updates, and sends the user to the release's page
//     (ReleasePage) to download it.
//  3. rel, err := e.Check(ctx). rel.Newer() reports whether it is an update, and rel.Same()
//     whether it is the running version. Downgrades are allowed, so a release that is neither is
//     still installable. rel.Policy says whether the running version must or should update.
//  4. The busy check (the core's Busy), with a confirmation when anything is running.
//  5. art, err := e.Download(ctx, rel, progress). The artifact is checked when this returns, and
//     everything is still running, so a failed download changes nothing.
//  6. The planned shutdown: the core's Shutdown with restart set, which records what is running
//     so that it comes back. On Windows no rcui.exe may keep running, so the core stops the mount
//     and serve children itself.
//  7. relaunch, err := e.Install(ctx, art). On error the old version is intact, so report the
//     error and start the app again. On Windows this starts the installer, which waits for this
//     process to exit.
//  8. Call relaunch(), then quit this process at once, with no confirmation and no further work.
//     relaunch waits for this process to exit before it starts the new version, so the new UI
//     doesn't run into this one's single-instance lock. On Windows the installer starts the new
//     version instead.
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

// Channel is a release channel.
type Channel string

// The channels. Beta follows the newest beta, or the stable release when that is newer. A beta is
// a numbered build of the version it leads to, such as 4.1.0-beta.1 (the release-beta workflow),
// so it is older than that version's own release.
const (
	Stable Channel = "stable"
	Beta   Channel = "beta"
)

// The feeds (FeedName). FeedURL is the stable channel's: the feed of GitHub's latest release, which
// is the one that a person set as the latest on the release page (see release.yml).
// ReleaseFeedURL is each release's own feed, used for --version and for a beta. {version} has no
// leading "v".
//
// GitHub has an address for the latest stable release only, so the beta channel finds its release
// in BetaListURL, GitHub's list of its ten newest releases: the newest pre-release there is the
// newest beta, and the channel reads that release's own feed (newestBeta). The list is GitHub's
// API, which answers 60 requests an hour for each network address. Only the beta channel asks
// it, once for each check.
const (
	FeedURL        = "https://github.com/rclone/rclone-ui/releases/latest/download/" + FeedName
	ReleaseFeedURL = "https://github.com/rclone/rclone-ui/releases/download/v{version}/" + FeedName
	BetaListURL    = "https://api.github.com/repos/rclone/rclone-ui/releases?per_page=10"
)

// ReleasesList is the list of releases, for a copy that can't update itself, and the start of each
// release's page (ReleasePage).
const ReleasesList = "https://github.com/rclone/rclone-ui/releases"

// PortableNote is why a portable copy doesn't update itself, and how to update it by hand.
const PortableNote = "This is a portable copy of Rclone UI, which doesn't update itself. Download the new release's portable zip, and replace rcui.exe, winfsp.msi and the bin folder with the ones in it. Your data folder and rclone.conf stay as they are."

// ReleasePage returns the page with the downloads of version, or ReleasesList when version is "".
func ReleasePage(version string) string {
	if version = strings.TrimPrefix(strings.TrimSpace(version), "v"); version == "" {
		return ReleasesList
	}
	return ReleasesList + "/tag/v" + url.PathEscape(version)
}

// Errors that the front ends handle separately.
var (
	// ErrNoRelease means the feed has no such release, as for a --version that was never
	// released.
	ErrNoRelease = errs.New("no such release")
	// ErrNoArtifact means the release has no download for this platform and package.
	ErrNoArtifact = errs.New("the release has no download for this platform")
	// ErrCantSelfUpdate means this install type updates some other way (CanSelfUpdate says how).
	ErrCantSelfUpdate = errs.New("this copy of Rclone UI can't update itself")
	// ErrBadVersion means the requested version isn't a release version, such as "4.0.2" or
	// "4.1.0-beta.1".
	ErrBadVersion = errs.New("not an Rclone UI version, like 4.0.2")
	// ErrFeedFormat means the feed is in a format that this build doesn't read (FeedFormat).
	ErrFeedFormat = errs.New("unknown feed format")
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
	location   string    // the bundle, $APPIMAGE, the executable, or the install folder
	blocked    i18n.Text // why a detected install type still can't update; zero when it can
}

// installInfo holds what detectInstall found.
type installInfo struct {
	installed InstallType
	location  string
	blocked   i18n.Text
}

// detected runs detectInstall once per process. The running install doesn't change while the
// process runs, and on Linux detection starts dpkg-query and rpm, which every engine would
// otherwise run again.
var detected = sync.OnceValue(func() installInfo {
	it, location, blocked := detectInstall()
	return installInfo{installed: it, location: location, blocked: blocked}
})

// responseHeaderTimeout limits the wait for a server's response. There is no limit on the whole
// body, because a large download on a slow connection may take any amount of time, as long as it
// doesn't stall (see stallTimeout).
const responseHeaderTimeout = 30 * time.Second

// defaultClient is the HTTP client that engines use. There is one per process, so its connections
// are reused.
var defaultClient = sync.OnceValue(func() *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.ResponseHeaderTimeout = responseHeaderTimeout
	return &http.Client{Transport: t}
})

// New makes an engine. Nothing is fetched until Check.
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
		if e.installed != "" { // set by Options.Installed, or by a test
			return
		}
		d := detected()
		e.installed, e.location, e.blocked = d.installed, d.location, d.blocked
	})
}
