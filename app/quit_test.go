package app

import (
	"log/slog"
	"testing"

	settingspb "github.com/rclone/rclone-ui/core/settings"
)

func testUI() *ui { return &ui{log: slog.New(slog.DiscardHandler)} }

func TestShouldQuitLetsTheOSEndTheSession(t *testing.T) {
	defer func(f func() bool) { endingSession = f }(endingSession)
	endingSession = func() bool { return true }
	u := testUI()
	if !u.shouldQuit() {
		t.Fatal("the OS's quit was vetoed")
	}
	if !u.quitting.Load() || !u.sessionEnding.Load() {
		t.Fatalf("quitting %v, sessionEnding %v", u.quitting.Load(), u.sessionEnding.Load())
	}
}

func TestResumeOnStop(t *testing.T) {
	for _, c := range []struct {
		ending, setting, want bool
	}{
		{false, false, false},
		{true, false, false},
		{false, true, false},
		{true, true, true},
	} {
		u := testUI()
		u.sessionEnding.Store(c.ending)
		u.applied.cur, u.applied.loaded = settingspb.Settings{General: settingspb.General{ResumeAfterLogout: c.setting}}, true
		if got := u.resumeOnStop(); got != c.want {
			t.Errorf("ending %v, setting %v: %v", c.ending, c.setting, got)
		}
	}
}

func TestEndSessionMessages(t *testing.T) {
	u := testUI()
	if ret, handled := u.wndProc(0, wmEndSession, 0, 0); ret != 0 || !handled {
		t.Fatalf("cancelled: %d %v", ret, handled)
	}
	if u.quitting.Load() || u.sessionEnding.Load() {
		t.Fatal("a cancelled end of the session set the flags")
	}
	if _, handled := u.wndProc(0, 0x0011 /* WM_QUERYENDSESSION */, 1, 0); handled || u.quitting.Load() {
		t.Fatal("another message was taken")
	}
	if ret, handled := u.wndProc(0, wmEndSession, 1, 0); ret != 0 || handled {
		t.Fatalf("ending: %d %v", ret, handled)
	}
	if !u.quitting.Load() || !u.sessionEnding.Load() {
		t.Fatal("an ending session didn't set the flags")
	}
}

func TestSessionEndEvent(t *testing.T) {
	for _, c := range []struct {
		class, id, reason uint32
		want              bool
	}{
		{aeCoreEventClass, aeQuitApplication, aeReallyLogOut, true},
		{aeCoreEventClass, aeQuitApplication, aeLogOut, true},
		{aeCoreEventClass, aeQuitApplication, aeRestart, true},
		{aeCoreEventClass, aeQuitApplication, aeShowRestartDialog, true},
		{aeCoreEventClass, aeQuitApplication, aeShutDown, true},
		{aeCoreEventClass, aeQuitApplication, aeShowShutdownDialog, true},
		{aeCoreEventClass, aeQuitApplication, 0, false},
		{aeCoreEventClass, aeQuitApplication, 0x71756961 /* 'quia', kAEQuitAll */, false},
		{aeCoreEventClass, 0x6f646f63 /* 'odoc' */, aeShutDown, false},
		{0, 0, 0, false},
	} {
		if got := sessionEndEvent(c.class, c.id, c.reason); got != c.want {
			t.Errorf("%#x %#x %#x: %v", c.class, c.id, c.reason, got)
		}
	}
}
