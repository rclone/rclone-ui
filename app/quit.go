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

// endingSession reports whether the quit that Wails is asking about comes from the OS ending the
// session. Tests replace it.
var endingSession = osEndingSession

// shouldQuit lets the app veto a quit in Wails. ⌘Q, the menu's Quit, the Dock and the OS all end
// up here, and all of them go through the quit flow. Only two quits are allowed through: the
// quit flow's own exit, and the OS ending the session (a logout, a restart or a shutdown), because
// a veto there would cancel the session's end. shouldQuit runs on the main thread, where a dialog
// would deadlock.
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

// endSession lets the OS end the session. onShutdown then stops the core before the OS gives up
// waiting.
func (u *ui) endSession() {
	u.sessionEnding.Store(true)
	u.quitting.Store(true)
	// Wails closes the windows next, and a window with unsaved changes must not hold that up.
	if u.windows != nil {
		u.windows.Closing()
	}
	u.log.Info("the OS is ending the session")
}

const wmEndSession = 0x0016

// wndProc is Wails' WndProcInterceptor, which only Windows calls. It sees every message sent to
// the app's main-thread window, so it checks msg first. Wails quits on WM_ENDSESSION whatever the
// wParam is. A wParam of 0 means another app cancelled the end of the session, so the message is
// swallowed and the app keeps running. A wParam of 1 means the session ends. Wails' Quit then
// runs shouldQuit and onShutdown while handling the message, before Windows ends the process.
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

// quit is the only way the app exits. force skips the confirmation, as for a signal or the crash
// dialog's Exit. If a quit is already under way, quit does nothing. An update that is being
// installed finishes first (see updateFlow.holdInstalls), because exiting halfway would leave the
// app half replaced. The launcher is suspended while the question is asked, because anything
// started from it would be missing from the question's list and would not survive the stop.
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
	// From now on no window shows again, not even one that is still loading, because stopping
	// the core can take a while.
	u.windows.Closing()
	u.hideWindows()
	u.stopCore(ctx, false)
	u.exit()
}

// confirmStop asks before stopping a busy core, for a Restart or an Update, which open the app
// again. title and action are the dialog's title and its button, in the app's language. It
// returns true when nothing is running or the user agreed. A core that doesn't answer counts as
// idle, because a dead core runs no transfers.
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

// confirmQuit asks before quitting when anything is running, or when watchers or schedules would
// stop running while the app is closed. It returns true when there is nothing to ask about or
// the user agreed.
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

// busyMessage returns the confirmation's text. It names what a stop would interrupt with the
// same phrase as the launcher's Stop Everything, and then lists it.
func busyMessage(busy core.BusyList) string {
	const shown = 8
	labels := busyLabels(busy.Items)
	var b strings.Builder
	// Phrase starts with a lower-case letter. The whole sentence is capitalized, because a
	// translation may not start with the phrase.
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

// quitMessage returns the quit dialog's text: what a quit would stop, and the watchers and
// schedules that won't run while the app is closed. It is "" when there is neither.
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

// keptMessage says which watchers and schedules won't run while the app is closed: "your
// watcher", "your 3 schedules", "your watcher and 2 schedules", "your 2 watchers and 1 schedule".
// A single watcher or schedule is named without its number. It is "" when there are none.
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

// exit ends the process through Wails, bypassing the veto in shouldQuit.
func (u *ui) exit() {
	u.quitting.Store(true)
	u.app.Quit()
}

// resumeOnStop reports whether the core's last stop should record what is running for the next
// start. That happens when the OS is ending the session and the user asked for things to come
// back afterwards (in Settings › General).
func (u *ui) resumeOnStop() bool {
	return u.sessionEnding.Load() && u.settings().General.ResumeAfterLogout
}

// onShutdown is the last call from Wails. It runs on the main thread, inside the
// applicationShouldTerminate: handler on macOS and inside WM_ENDSESSION on Windows. A core that
// is still running stops here, for example after an exit that skipped the quit flow or when the
// OS ends the session. It records what is running when it should, and it must finish before the
// OS stops waiting for a slow app (about 10 seconds). A child process that outlives the core
// exits when its stdin closes along with this process.
func (u *ui) onShutdown() {
	u.quitting.Store(true)
	// Agents are cut off first, so that none starts something while the core stops.
	u.agents.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	u.stopCore(ctx, u.resumeOnStop())
	u.log.Info("stopped")
}
