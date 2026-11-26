package app

import (
	"context"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/rclone/rclone-ui/app/interaction"
	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/i18n"
)

var endingSession = osEndingSession

// A veto while the OS ends the session (a logout, a restart or a shutdown) would cancel the
// session's end. Wails calls shouldQuit on the main thread, where a dialog would deadlock.
func (u *ui) shouldQuit() bool {
	if u.quitting.Load() {
		return true
	}
	if endingSession() {
		u.endSession()
		return true
	}
	go u.quit(false)
	return false
}

func (u *ui) endSession() {
	u.sessionEnding.Store(true)
	u.quitting.Store(true)
	if u.windows != nil {
		u.windows.Closing()
	}
	u.log.Info("the OS is ending the session")
}

const wmEndSession = 0x0016

// Wails quits on WM_ENDSESSION whatever the wParam is. A wParam of 0 means another app cancelled
// the end of the session, so the message is swallowed. With a wParam of 1, Wails runs
// shouldQuit and onShutdown while it handles the message, before Windows ends the process.
func (u *ui) wndProc(_ uintptr, msg uint32, wParam, _ uintptr) (uintptr, bool) {
	if msg != wmEndSession {
		return 0, false
	}
	if wParam == 0 {
		return 0, true
	}
	u.endSession()
	return 0, false
}

// The Apple event that asks an app to quit, and the quit reasons that mean the session is ending,
// as their four-character codes (from AppleEvents.h and AERegistry.h).
const (
	aeCoreEventClass     = 0x61657674 // 'aevt'
	aeQuitApplication    = 0x71756974 // 'quit'
	aeLogOut             = 0x6c6f676f // 'logo'
	aeReallyLogOut       = 0x726c676f // 'rlgo'
	aeRestart            = 0x72657374 // 'rest'
	aeShowRestartDialog  = 0x72727374 // 'rrst'
	aeShutDown           = 0x73687574 // 'shut'
	aeShowShutdownDialog = 0x7273646e // 'rsdn'
)

// sessionEndEvent reports whether an Apple event is the quit that loginwindow sends for a logout,
// a restart or a shutdown. That is a quit event whose kAEQuitReason is one of those reasons. ⌘Q
// sends no event, and the Dock's Quit sends one without a reason.
func sessionEndEvent(class, id, reason uint32) bool {
	if class != aeCoreEventClass || id != aeQuitApplication {
		return false
	}
	switch reason {
	case aeLogOut, aeReallyLogOut, aeRestart, aeShowRestartDialog, aeShutDown, aeShowShutdownDialog:
		return true
	}
	return false
}

func (u *ui) quit(force bool) {
	if !u.quitMu.TryLock() {
		return
	}
	defer u.quitMu.Unlock()
	defer u.updates.holdInstalls()()
	if u.quitting.Load() {
		return
	}
	u.launcher.Suspend()
	ctx := context.Background()
	if !force && !u.confirmQuit(ctx) {
		u.launcher.Resume()
		return
	}
	u.log.Info("quitting")
	u.windows.Closing()
	u.hideWindows()
	u.stopCore(ctx, false)
	u.exit()
}

func (u *ui) confirmStop(ctx context.Context, title, action string) bool {
	c := u.theCore()
	if c == nil {
		return true
	}
	b := c.Busy(ctx)
	if len(b.Items) == 0 {
		return true
	}
	return interaction.Ask(interaction.Warning, title, busyMessage(b), action, i18n.T("Cancel"))
}

func (u *ui) confirmQuit(ctx context.Context) bool {
	c := u.theCore()
	if c == nil {
		return true
	}
	k := c.KeepsRunning(ctx)
	text := quitMessage(c.Busy(ctx), k.Watchers, k.Schedules)
	if text == "" {
		return true
	}
	// i18n: The title of the dialog that asks before the app quits while it has work running.
	title := i18n.T("Exit")
	// i18n: The button that quits the app.
	return interaction.Ask(interaction.Warning, title, text, i18n.T("Quit"), i18n.T("Cancel"))
}

func busyLabels(items []core.BusyItem) []string {
	labels := make([]string, 0, len(items))
	for _, it := range items {
		l := it.Label
		if d := it.Detail; d != "" {
			l += " (" + d + ")"
		}
		labels = append(labels, l)
	}
	return labels
}

func busyMessage(busy core.BusyList) string {
	const shown = 8
	labels := busyLabels(busy.Items)
	var b strings.Builder
	if busy.Running != (core.Running{}) {
		// i18n: The start of the quit dialog, followed by a list. %s names what is running: "2 transfers, a serve and 3 mounts".
		b.WriteString(capitalize(i18n.T("%s will be stopped:", busy.Running.Phrase())) + "\n")
	} else {
		// i18n: The start of the quit dialog, followed by a list of what is running.
		b.WriteString(i18n.T("These will be stopped:") + "\n")
	}
	for i, l := range labels {
		if i == shown {
			more := len(labels) - shown
			// i18n: The end of a list that is cut short.
			b.WriteString("\n" + i18n.N("…and %d more", "…and %d more", more, more))
			break
		}
		b.WriteString("\n• " + l)
	}
	return b.String()
}

func capitalize(s string) string {
	r, n := utf8.DecodeRuneInString(s)
	if r == utf8.RuneError {
		return s
	}
	return string(unicode.ToUpper(r)) + s[n:]
}

func quitMessage(b core.BusyList, watchers, schedules int) string {
	var parts []string
	if len(b.Items) > 0 {
		parts = append(parts, busyMessage(b))
	}
	if kept := keptMessage(watchers, schedules); kept != "" {
		parts = append(parts, kept)
	}
	return strings.Join(parts, "\n\n")
}

func keptMessage(watchers, schedules int) string {
	switch {
	case watchers == 0 && schedules == 0:
		return ""
	case schedules == 0 && watchers == 1:
		return i18n.T("While Rclone UI is closed, your watcher won't run. It starts again when you open it.")
	case schedules == 0:
		return i18n.N("While Rclone UI is closed, your %d watcher won't run. It starts again when you open it.",
			"While Rclone UI is closed, your %d watchers won't run. They start again when you open it.", watchers, watchers)
	case watchers == 0 && schedules == 1:
		return i18n.T("While Rclone UI is closed, your schedule won't run. It starts again when you open it.")
	case watchers == 0:
		return i18n.N("While Rclone UI is closed, your %d schedule won't run. It starts again when you open it.",
			"While Rclone UI is closed, your %d schedules won't run. They start again when you open it.", schedules, schedules)
	}
	w := i18n.MN("%d watcher", "%d watchers", watchers, watchers)
	if watchers == 1 {
		// i18n: The one watcher in "your watcher and 2 schedules".
		w = i18n.M("watcher")
	}
	s := i18n.MN("%d schedule", "%d schedules", schedules, schedules)
	// i18n: The quit dialog's last line, when watchers and schedules won't run: "your watcher and 2 schedules", "your 2 watchers and 1 schedule".
	return i18n.T("While Rclone UI is closed, your %s and %s won't run. They start again when you open it.", w, s)
}

func (u *ui) exit() {
	u.quitting.Store(true)
	u.app.Quit()
}

func (u *ui) resumeOnStop() bool {
	return u.sessionEnding.Load() && u.settings().General.ResumeAfterLogout
}

// Wails calls onShutdown on the main thread, inside applicationShouldTerminate: on macOS and
// inside WM_ENDSESSION on Windows. It must finish before the OS stops waiting for a slow app
// (about 10 seconds).
func (u *ui) onShutdown() {
	u.quitting.Store(true)
	u.agents.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	u.stopCore(ctx, u.resumeOnStop())
	u.log.Info("stopped")
}
