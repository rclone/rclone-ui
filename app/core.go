package app

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"sync"

	"github.com/rclone/rclone-ui/app/interaction"
	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/version"
)

type coreHost struct {
	mu         sync.Mutex
	core       *core.Core
	status     CoreStatus
	failed     error
	stopEvents func()
}

func (u *ui) startCore() {
	u.setCoreStatus(CoreStatus{State: CoreStarting})
	var hostEnv []string
	if platform.AppDir() != "" {
		hostEnv = platform.HostEnv()
	}
	c, err := core.Start(core.Options{
		DataDir: u.opts.dataDir,
		RunDir:  os.Getenv("APP_RUN_DIR"),
		Log:     u.logs,
		HostEnv: hostEnv,
		APIs:    u.apis,
	})
	if err != nil {
		u.coreFailed(err)
		return
	}
	u.cores.mu.Lock()
	u.cores.core = c
	u.cores.stopEvents = c.Subscribe(u.coreEvent)
	u.cores.mu.Unlock()
	u.setCoreStatus(CoreStatus{State: CoreReady, Version: version.App})
	u.coreReady()
	if crashed, interrupted := c.Crashed(); crashed {
		go u.crashNotice(interrupted)
	}
}

// Trying again needs a new process, because the state that rclone set up in this one would remain.
func (u *ui) coreFailed(err error) {
	u.log.Error("the core can't run", "error", err)
	u.cores.mu.Lock()
	u.cores.failed = err
	u.cores.mu.Unlock()
	u.setCoreStatus(CoreStatus{State: CoreFailed, Error: i18n.Localize(err)})
	u.coreDown()
	u.showStartup()
	u.updates.startUp()
	title := i18n.T("Rclone UI Can't Start")
	switch failedChoice(err) {
	case showDataFolder:
		if interaction.Ask(interaction.Error, title, i18n.Localize(err), i18n.T("Show Data Folder"), i18n.T("Quit")) {
			if err := u.reveal(u.dataDir, true); err != nil {
				u.log.Error("could not show the data folder", "error", err)
			}
		}
	case tryAgain:
		if interaction.Ask(interaction.Error, title, i18n.Localize(err), i18n.T("Try Again"), i18n.T("Quit")) {
			u.relaunch("")
			return
		}
	}
	u.quit(true)
}

const (
	tryAgain       = "try again"
	showDataFolder = "show data folder"
)

func failedChoice(err error) string {
	if errors.Is(err, db.ErrSchemaChanged) {
		return showDataFolder
	}
	return tryAgain
}

func (u *ui) coreReady() {
	go func() {
		u.loadSettings(context.Background())
		u.checkProxy(context.Background())
		u.updates.startUp()
		u.firstReady.Do(u.showStartup)
		u.unlockConfig(context.Background())
	}()
	u.store.CoreReady(context.Background())
	u.launcher.CoreReady()
}

func (u *ui) crashNotice(interrupted int) {
	// i18n: The body of the notification that Rclone UI quit unexpectedly: it is running again.
	body := i18n.T("It was started again.")
	if interrupted > 0 {
		body = i18n.N("%d transfer was interrupted.", "%d transfers were interrupted.", interrupted, interrupted)
	}
	u.notifier.show(toast{title: i18n.T("Rclone UI quit unexpectedly"), body: body, route: "/history"})
}

func (u *ui) stopCore(ctx context.Context, restart bool) {
	u.cores.mu.Lock()
	c, stop := u.cores.core, u.cores.stopEvents
	u.cores.mu.Unlock()
	if c == nil {
		return
	}
	if stop != nil {
		stop()
	}
	u.coreDown()
	c.Shutdown(ctx, restart)
	u.setCoreStatus(CoreStatus{State: CoreStopped})
}

func (u *ui) theCore() *core.Core {
	u.cores.mu.Lock()
	defer u.cores.mu.Unlock()
	return u.cores.core
}

// A named type, so that the bindings give the pages an enum.
type CoreState string

const (
	CoreStarting CoreState = "starting"
	CoreReady    CoreState = "ready"
	CoreFailed   CoreState = "failed"
	CoreStopped  CoreState = "stopped"
)

func (u *ui) setCoreStatus(s CoreStatus) {
	u.cores.mu.Lock()
	u.cores.status = s
	u.cores.mu.Unlock()
	u.log.Info("core", "state", s.State)
	u.app.Event.Emit(EventCoreState, s)
}

func (u *ui) coreStatus() CoreStatus {
	u.cores.mu.Lock()
	defer u.cores.mu.Unlock()
	s := u.cores.status
	if s.State == CoreFailed && u.cores.failed != nil {
		s.Error = i18n.Localize(u.cores.failed)
	}
	return s
}

func (u *ui) coreEvent(ev bus.Event) {
	u.relayCoreEvent(ev)
	u.store.Event(context.Background(), ev)
	if d, ok := ev.Data.(bus.NotifyOSData); ok {
		go u.notifier.show(toast{title: d.Title, body: d.Body, route: d.Route, toastOnly: d.ToastOnly})
	}
	switch ev.Name {
	case bus.SettingsChanged, bus.Resync:
		go u.loadSettings(context.Background())
	}
}

func (u *ui) relaunch(open string) {
	args := []string{"ui", "--hidden", "--after", strconv.Itoa(os.Getpid())}
	if u.opts.dataDir != "" {
		args = append(args, "--data-dir", u.opts.dataDir)
	}
	if open != "" {
		args = append(args, "--open", open)
	}
	cmd := exec.Command(u.exe, args...)
	cmd.SysProcAttr = platform.DetachedProcess()
	if err := cmd.Start(); err != nil {
		u.log.Error("could not start the app again", "error", err)
		interaction.Message(interaction.Error, "Rclone UI", i18n.T("Rclone UI could not start again: %v. Start it yourself.", err))
	} else {
		_ = cmd.Process.Release()
	}
	u.quit(true)
}
