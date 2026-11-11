package app

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rclone/rclone-ui/app/interaction"
	"github.com/rclone/rclone-ui/app/update"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/notifications"
)

// UpdateRequest says which release to check for. Empty fields mean the latest release on the
// user's channel. `rcui update --version X` can ask for a specific version.
type UpdateRequest struct {
	Version string
	// Channel is "stable" or "beta".
	Channel string
}

type UpdateRelease struct {
	Version string `json:"version"`
	// Current is the running version.
	Current string `json:"current"`
	Notes   string `json:"notes"`
	// Date is the release date (RFC 3339).
	Date string `json:"date"`
	// Rclone is the version of rclone included in the release.
	Rclone string `json:"rclone"`
	// Required means the running version is below the policy's minimum, and the app can't be used
	// without updating.
	Required bool `json:"required"`
	// Recommended means the running version is below the policy's recommended version, so the app
	// offers the update at start. Otherwise only "Check for updates" in Settings offers it.
	Recommended bool `json:"recommended"`
	// Page is the release's page on GitHub, with its downloads. A portable copy, which doesn't
	// update itself, sends the user there.
	Page string `json:"page"`
}

// releaseFor returns the release that the app offers, or nil. found is offered when it is newer
// than the running version, or when a specific version was asked for, which allows downgrades.
func releaseFor(found *update.Release, asked string) *UpdateRelease {
	if asked == "" && !found.Newer() {
		return nil
	}
	p := found.Policy
	older := func(v string) bool { return v != "" && update.CompareVersions(found.Current, v) < 0 }
	return &UpdateRelease{
		Version: found.Version, Current: found.Current, Notes: found.Notes, Rclone: found.Rclone,
		Date:        found.PubDate.Format(time.RFC3339),
		Required:    older(p.Minimum),
		Recommended: older(p.Minimum) || older(p.Recommended),
		Page:        update.ReleasePage(found.Version),
	}
}

// updateFlow is the UI's update flow around the engine in app/update. It decides when to check
// and what to ask, runs the busy check, stops the core and exits. The engine does the rest. Only
// one update runs at a time.
type updateFlow struct {
	u *ui
	// enabled is true for a release build, or for a development build that uses a test feed
	// (see testFeed). The real feed would offer to replace a development build with the latest
	// release.
	enabled bool
	// engine holds the options that every engine of the flow starts from: the test feed, and in
	// the tests, the install type.
	engine update.Options

	running   sync.Mutex // held while an update runs
	startOnce sync.Once
	mu        sync.Mutex
	last      *offer // what the last check found
	// reported is the release that app.update-available was last sent for.
	reported string

	// installing is held from the moment the core stops until the exit, or until the relaunch
	// when the install fails. A quit holds it too, so neither can interrupt the other halfway.
	installing sync.Mutex
	// quitWaiting is set when a quit is waiting for the install. A successful install then exits
	// without relaunching.
	quitWaiting atomic.Bool
}

// offer is what a check found. It holds the release as pages see it, plus the engine and the
// release that install it. install downloads found and never reads the feed again, so the release
// that gets installed is the one that was offered.
type offer struct {
	rel   *UpdateRelease
	eng   *update.Engine
	found *update.Release
}

// release returns the offer as pages see it, or nil when there is no offer.
func (o *offer) release() *UpdateRelease {
	if o == nil {
		return nil
	}
	return o.rel
}

func (f *updateFlow) state(s UpdateState) {
	f.u.app.Event.Emit(EventUpdateState, s)
}

func (f *updateFlow) channel(req UpdateRequest) update.Channel {
	ch := update.Channel(req.Channel)
	if ch == "" {
		ch = update.Channel(f.u.settings().Updates.Channel)
	}
	if ch == "" {
		ch = update.Stable
	}
	return ch
}

// available reports whether this install can update itself, and why not when it can't, in the
// app's language. A portable copy can't, but it still checks for updates and sends the user to
// the release's page (Manual).
func (f *updateFlow) available() UpdateAvailability {
	if !f.enabled {
		return UpdateAvailability{Why: i18n.T("Updates are not available in this build.")}
	}
	e := update.New(f.engine)
	why := e.WhyNot()
	ok := why.IsZero()
	return UpdateAvailability{OK: ok, Why: why.Local(), Manual: !ok && e.InstallType() == update.TypePortable}
}

// check reads the feed. The offer is nil when the app is up to date, and in a build that doesn't
// update. Only a check with an empty req keeps its offer for Install and reports it to the
// notification targets. An offer from an update link is not kept, so that a later press of Update
// in Settings never installs it.
func (f *updateFlow) check(ctx context.Context, req UpdateRequest) (*offer, error) {
	if !f.enabled {
		return nil, nil
	}
	ch := f.channel(req)
	f.u.log.Info("checking for updates", "channel", ch)
	f.state(UpdateState{Phase: "checking"})
	opts := f.engine
	opts.Channel, opts.Version = ch, req.Version
	eng := update.New(opts)
	found, err := eng.Check(ctx)
	if err != nil {
		f.state(UpdateState{Phase: "error", Error: i18n.Localize(err)})
		return nil, err
	}
	f.state(UpdateState{Phase: "idle"})
	var o *offer
	if rel := releaseFor(found, req.Version); rel != nil {
		o = &offer{rel: rel, eng: eng, found: found}
	}
	if req != (UpdateRequest{}) {
		return o, nil
	}
	f.mu.Lock()
	f.last = o
	f.mu.Unlock()
	if o != nil {
		f.u.log.Info("an update is available", "version", o.rel.Version, "current", o.rel.Current, "required", o.rel.Required)
		f.report(o.rel)
	}
	return o, nil
}

// report sends app.update-available through the core's notification targets. It sends it once
// per release, because the check runs at every start and on demand.
func (f *updateFlow) report(rel *UpdateRelease) {
	f.mu.Lock()
	sent := f.reported == rel.Version
	f.mu.Unlock()
	if sent {
		return
	}
	if f.u.theCore() == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := f.u.apis.Notifications.ReportUpdate(ctx, notifications.UpdateAvailable{
		Version: rel.Version, Current: rel.Current, Notes: rel.Notes,
	})
	if err != nil {
		f.u.log.Warn("could not report the update to the notification targets", "error", err)
		return
	}
	f.mu.Lock()
	f.reported = rel.Version
	f.mu.Unlock()
}

// startUp runs the startup check in the background, once per run of the UI. It is called once the
// core's settings are read, because the channel and the skipped version come from them. It is
// also called when the core failed to start, because a required update may fix the problem.
func (f *updateFlow) startUp() {
	f.startOnce.Do(func() { go f.atStart(context.Background()) })
}

// atStart is the check at start. It offers an update when the policy recommends or requires one.
func (f *updateFlow) atStart(ctx context.Context) {
	o, err := f.check(ctx, UpdateRequest{})
	if err != nil {
		f.u.log.Warn("could not check for updates", "error", err)
		return
	}
	rel := o.release()
	if rel == nil || (!rel.Required && !rel.Recommended) {
		return
	}
	if !rel.Required && rel.Version == f.u.settings().Updates.SkippedVersion {
		return
	}
	title, cancel := updateTitle(rel), i18n.T("Skip This Version")
	if rel.Required {
		// i18n: The button that quits the app instead of installing a required update.
		cancel = i18n.T("Exit")
	}
	// i18n: %s is the new version, such as 4.0.2.
	msg := i18n.T("You are running an outdated version of Rclone UI. Please update to the latest version (%s).", rel.Version)
	// A portable copy offers the release's page, where the user downloads it.
	avail := f.available()
	// i18n: The button that installs an update.
	button := i18n.T("Update")
	if avail.Manual {
		msg += "\n\n" + avail.Why
		// i18n: The button that opens the release's page, to download the update by hand.
		button = i18n.T("Download")
	}
	if !interaction.Ask(interaction.Info, title, msg, button, cancel) {
		if rel.Required {
			f.u.quit(true)
			return
		}
		f.u.skipVersion(ctx, rel.Version)
		return
	}
	if avail.Manual {
		f.openPage(rel)
		// The app can't be used below a required version, so it quits once the page is open.
		if rel.Required {
			f.u.quit(true)
		}
		return
	}
	f.install(ctx, o)
}

func updateTitle(rel *UpdateRelease) string {
	if rel.Required {
		return i18n.T("Update Required")
	}
	return i18n.T("Update Available")
}

func (f *updateFlow) openPage(rel *UpdateRelease) {
	if err := f.u.openURL(rel.Page); err != nil {
		f.u.log.Warn("could not open the release's page", "url", rel.Page, "error", err)
	}
}

// requested runs an update that an update link asked for. `rcui update` sends one to the running
// app, and so can any web page, so the app asks before it installs anything (linkQuestion). A
// failed check is reported, and so is a version that isn't a valid version, because the command
// told the user that the app would take over.
func (f *updateFlow) requested(ctx context.Context, req UpdateRequest) {
	// CheckVersion only refuses a version that isn't one, so the message says so.
	if err := update.CheckVersion(req.Version); err != nil {
		f.u.log.Warn("refused a requested update", "version", req.Version, "error", err)
		// i18n: %q is what an update link asked for, which isn't a version.
		msg := i18n.T("Rclone UI was asked to update to %q, but that is not an Rclone UI version, like 4.0.2.", req.Version)
		f.state(UpdateState{Phase: "error", Version: req.Version, Error: msg})
		interaction.Message(interaction.Warning, i18n.T("Update Refused"), msg)
		return
	}
	o, err := f.check(ctx, req)
	if err != nil {
		f.fail(req.Version, stepCheck, err)
		return
	}
	if o == nil {
		return
	}
	// A copy that can't update itself gets install's own dialog, which installs nothing.
	if f.available().OK {
		title, msg := linkQuestion(o.rel)
		// i18n: The button that installs an update.
		if !interaction.Ask(interaction.Question, title, msg, i18n.T("Update"), i18n.T("Cancel")) {
			f.u.log.Info("the user declined a requested update", "version", o.rel.Version)
			f.state(UpdateState{Phase: "idle"})
			return
		}
	}
	f.install(ctx, o)
}

// linkQuestion returns the title and the text of the question that requested asks before it
// installs rel.
func linkQuestion(rel *UpdateRelease) (title, msg string) {
	switch {
	case update.CompareVersions(rel.Version, rel.Current) < 0:
		// i18n: The running version, then the older one that a link asked for, such as 4.0.1.
		msg = i18n.T("Rclone UI was asked to change from version %s to %s, an older version.", rel.Current, rel.Version)
	case rel.Version == rel.Current:
		// i18n: The running version, which a link asked to install again.
		msg = i18n.T("Rclone UI was asked to install version %s again.", rel.Version)
	default:
		// i18n: The running version, then the newer one that a link asked for, such as 4.0.2.
		msg = i18n.T("Rclone UI was asked to update from version %s to %s.", rel.Current, rel.Version)
	}
	// i18n: Follows the request that an update link made.
	msg += "\n\n" + i18n.T("Choose Update only if you asked for this, for example with the rcui update command.")
	return updateTitle(rel), msg
}

// install runs the update steps: the download, the busy check, a planned stop of the core, the
// install and the relaunch. If a step fails, the app keeps running as it was. From the busy check
// on, the launcher is suspended, as for a quit, and it comes back if the update is cancelled or
// fails.
func (f *updateFlow) install(ctx context.Context, o *offer) {
	if !f.running.TryLock() {
		return
	}
	defer f.running.Unlock()
	rel := o.rel
	if avail := f.available(); !avail.OK {
		title := updateTitle(rel)
		if avail.Manual {
			if interaction.Ask(interaction.Info, title, avail.Why, i18n.T("Download"), i18n.T("Cancel")) {
				f.openPage(rel)
			}
		} else {
			interaction.Message(interaction.Info, title, avail.Why)
		}
		if rel.Required {
			f.u.quit(true)
		}
		return
	}
	f.state(UpdateState{Phase: "downloading", Version: rel.Version})
	art, err := o.eng.Download(ctx, o.found, func(done, total int64) {
		f.state(UpdateState{Phase: "downloading", Version: rel.Version, Done: done, Total: max(total, 0)})
	})
	if err != nil {
		f.fail(rel.Version, stepDownload, err)
		return
	}
	f.u.launcher.Suspend()
	// i18n: The title of the dialog that asks before an update stops what is running.
	if !f.u.confirmStop(ctx, i18n.T("Update"), i18n.T("Update and Restart")) {
		f.u.launcher.Resume()
		art.Remove()
		f.state(UpdateState{Phase: "idle"})
		return
	}
	// From here on, a quit (from the tray or a signal) waits, because exiting during the install
	// would leave the app half replaced. A quit that has already begun goes first, and if it exits,
	// the rest of this never runs.
	f.installing.Lock()
	defer f.installing.Unlock()
	if f.u.quitting.Load() {
		f.u.launcher.Resume() // the quit has its own Suspend, which keeps the launcher hidden
		art.Remove()
		return
	}
	f.state(UpdateState{Phase: "installing", Version: rel.Version})
	f.u.hideWindows()
	f.u.stopCore(ctx, true)
	relaunch, err := o.eng.Install(ctx, art)
	if err != nil {
		// The old version is intact, but its core has stopped and can only start again in a new
		// process. So the app is started again, and what was running comes back. The quit inside
		// relaunch waits for this install to return.
		art.Remove()
		f.fail(rel.Version, stepInstall, err)
		go f.u.relaunch("")
		return
	}
	// Nothing else cleans up the staging folders. The Windows installer is kept, because it reads
	// its file after the app exits.
	if art.Kind != update.KindNSIS {
		art.Remove()
	}
	if f.quitWaiting.Load() {
		f.u.log.Info("updated; not relaunching, since the app was asked to quit")
	} else if err := relaunch(); err != nil {
		f.u.log.Error("could not relaunch after the update", "error", err)
	}
	f.u.exit()
}

// holdInstalls is the quit's side of installing. It waits for an install that is under way, and
// keeps a new one from starting until the returned func is called. An install that succeeds in the
// meantime exits without relaunching the app. (On Windows, the installer still starts it.)
func (f *updateFlow) holdInstalls() (release func()) {
	if f == nil {
		return func() {}
	}
	if !f.installing.TryLock() {
		f.quitWaiting.Store(true)
		f.installing.Lock()
		f.quitWaiting.Store(false)
	}
	return f.installing.Unlock
}

type updateStep int

const (
	stepCheck updateStep = iota
	stepDownload
	stepInstall
)

func (s updateStep) String() string {
	return [...]string{"check", "download", "install"}[s]
}

// failure returns the text of the dialog that says the step failed with err, in the app's
// language. The engine's own errors are translated, and other errors (the network's, the OS's)
// keep their words.
func (s updateStep) failure(err error) string {
	switch s {
	case stepCheck:
		return i18n.T("Rclone UI could not check for the update: %s\n\nPlease try again, or tap \"Download\" to download the update manually.", err)
	case stepDownload:
		return i18n.T("Rclone UI could not download the update: %s\n\nPlease try again, or tap \"Download\" to download the update manually.", err)
	}
	return i18n.T("Rclone UI could not install the update: %s\n\nPlease try again, or tap \"Download\" to download the update manually.", err)
}

func (f *updateFlow) fail(version string, step updateStep, err error) {
	f.u.log.Error("the update failed", "version", version, "step", step.String(), "error", err)
	f.state(UpdateState{Phase: "error", Version: version, Error: i18n.Localize(err)})
	// i18n: The second button is "OK", which closes the dialog.
	if interaction.Ask(interaction.Error, i18n.T("Update Failed"), step.failure(err), i18n.T("Download"), i18n.T("OK")) {
		if err := f.u.openURL(update.ReleasePage(version)); err != nil {
			f.u.log.Warn("could not open the releases page", "error", err)
		}
	}
}

type UpdateService struct{ u *ui }

// UpdateAvailability says whether this install can update itself, and why not.
type UpdateAvailability struct {
	OK  bool   `json:"ok"`
	Why string `json:"why"`
	// Manual means the install can't update itself, but still checks for updates, as a portable
	// copy does. The user downloads a release that a check finds from its page
	// (UpdateRelease.Page).
	Manual bool `json:"manual"`
}

func (s *UpdateService) Available() UpdateAvailability { return s.u.updates.available() }

// Check looks for a newer release. It returns nil when the app is up to date.
func (s *UpdateService) Check(ctx context.Context) (*UpdateRelease, error) {
	o, err := s.u.updates.check(ctx, UpdateRequest{})
	if err != nil {
		// The engine makes its errors with core/errs, so that the page gets them in the app's
		// language. errs.Failed keeps them failures, which a second try may fix, rather than
		// rejected requests.
		return nil, errs.Failed(err)
	}
	return o.release(), nil
}

// Install runs the update steps for the release that Check found, and checks first if Check
// hasn't run.
func (s *UpdateService) Install(ctx context.Context) error {
	f := s.u.updates
	f.mu.Lock()
	o := f.last
	f.mu.Unlock()
	if o == nil {
		var err error
		if o, err = f.check(ctx, UpdateRequest{}); err != nil {
			return errs.Failed(err)
		}
		if o == nil {
			return errs.New("Rclone UI is up to date.")
		}
	}
	// The download and the relaunch continue after the page's call returns.
	go f.install(context.Background(), o)
	return nil
}
