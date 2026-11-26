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

type UpdateRequest struct {
	Version string
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
	// Page is the release's page on GitHub, with its downloads.
	Page string `json:"page"`
}

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

type updateFlow struct {
	u       *ui
	enabled bool
	engine  update.Options

	running   sync.Mutex
	startOnce sync.Once
	mu        sync.Mutex
	last      *offer
	reported  string

	installing  sync.Mutex
	quitWaiting atomic.Bool
}

type offer struct {
	rel   *UpdateRelease
	eng   *update.Engine
	found *update.Release
}

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

func (f *updateFlow) available() UpdateAvailability {
	if !f.enabled {
		return UpdateAvailability{Why: i18n.T("Updates are not available in this build.")}
	}
	e := update.New(f.engine)
	why := e.WhyNot()
	ok := why.IsZero()
	return UpdateAvailability{OK: ok, Why: why.Local(), Manual: !ok && e.InstallType() == update.TypePortable}
}

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

func (f *updateFlow) startUp() {
	f.startOnce.Do(func() { go f.atStart(context.Background()) })
}

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

func (f *updateFlow) requested(ctx context.Context, req UpdateRequest) {
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
	f.installing.Lock()
	defer f.installing.Unlock()
	if f.u.quitting.Load() {
		f.u.launcher.Resume()
		art.Remove()
		return
	}
	f.state(UpdateState{Phase: "installing", Version: rel.Version})
	f.u.hideWindows()
	f.u.stopCore(ctx, true)
	relaunch, err := o.eng.Install(ctx, art)
	if err != nil {
		art.Remove()
		f.fail(rel.Version, stepInstall, err)
		go f.u.relaunch("")
		return
	}
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
	// copy does.
	Manual bool `json:"manual"`
}

func (s *UpdateService) Available() UpdateAvailability { return s.u.updates.available() }

// Check looks for a newer release. It returns nil when the app is up to date.
func (s *UpdateService) Check(ctx context.Context) (*UpdateRelease, error) {
	o, err := s.u.updates.check(ctx, UpdateRequest{})
	if err != nil {
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
	go f.install(context.Background(), o)
	return nil
}
