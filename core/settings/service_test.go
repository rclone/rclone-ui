package settings

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/testdb"
)

func ptr[T any](v T) *T { return &v }

func TestDefaultsThenUpdates(t *testing.T) {
	ctx := context.Background()
	b := bus.New()
	sub := b.Subscribe()
	defer sub.Close()
	s := New(testdb.Open(t), b)

	st, err := s.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(st, Defaults()) {
		t.Fatalf("before anything is saved: %v", st)
	}

	// Updating one field leaves the rest unchanged and doesn't require a restart.
	st, restart, err := s.Update(ctx, Patch{HideStartup: ptr(true)})
	if err != nil || restart {
		t.Fatalf("Update: %v restart %v", err, restart)
	}
	if !st.General.HideStartup || st.General.LauncherShortcut != "" || st.Updates.Channel != "stable" {
		t.Errorf("after one field: %v", st)
	}
	if ev := <-sub.C; ev.Name != bus.SettingsChanged {
		t.Errorf("event %q", ev.Name)
	}

	// The proxy only applies after the app starts again.
	st, restart, err = s.Update(ctx, Patch{Proxy: &Proxy{URL: "http://proxy:3128", IgnoredHosts: []string{"localhost"}}})
	if err != nil || !restart || st.Proxy.URL != "http://proxy:3128" {
		t.Fatalf("the proxy: %v, restart %v, %v", err, restart, st)
	}

	again, err := s.Get(ctx)
	if err != nil || !reflect.DeepEqual(again, st) {
		t.Errorf("read back %v, %v; want %v", again, err, st)
	}

	// An empty proxy clears it, ignored hosts included.
	st, _, err = s.Update(ctx, Patch{Proxy: &Proxy{}})
	if err != nil || st.Proxy.URL != "" || st.Proxy.IgnoredHosts == nil || len(st.Proxy.IgnoredHosts) != 0 {
		t.Errorf("cleared proxy: %v %v", st, err)
	}
}

// A nil field of a patch keeps its value, and a field set to its zero value replaces it.
func TestPatchKeepsNilFields(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New())
	if _, _, err := s.Update(ctx, Patch{
		HideStartup: ptr(true), LauncherShortcut: ptr("Alt+Space"), ShowInDock: ptr(true),
		TrayIcon: ptr(TrayIconDark), Channel: ptr("beta"), BwLimit: ptr("1M"),
	}); err != nil {
		t.Fatal(err)
	}
	st, _, err := s.Update(ctx, Patch{ShowInDock: ptr(false)})
	if err != nil {
		t.Fatal(err)
	}
	want := Defaults()
	want.General = General{HideStartup: true, LauncherShortcut: "Alt+Space"}
	want.Appearance.TrayIcon = TrayIconDark
	want.Updates.Channel = "beta"
	want.Transfers.BwLimit = "1M"
	want.Telemetry.ID = st.Telemetry.ID // made by the first update where the data is shared
	if !reflect.DeepEqual(st, want) {
		t.Errorf("got %+v, want %+v", st, want)
	}
	if again, err := s.Get(ctx); err != nil || !reflect.DeepEqual(again, want) {
		t.Errorf("read back %+v, %v", again, err)
	}
}

// TestUpdatesAtOnceKeepEveryChange checks that updates to different fields sent at the same time
// (two Settings toggles) each keep their change. Neither one writes the document from a read made
// before the other's write.
func TestUpdatesAtOnceKeepEveryChange(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New())
	for round := range 50 {
		on, tag := round%2 == 0, fmt.Sprintf("v%d", round)
		updates := []Patch{
			{HideStartup: ptr(on)},
			{ResumeAfterLogout: ptr(on)},
			{ShowInDock: ptr(on)},
			{LauncherShortcut: ptr(tag)},
			{SkippedVersion: ptr(tag)},
		}
		var wg sync.WaitGroup
		for _, p := range updates {
			wg.Go(func() {
				if _, _, err := s.Update(ctx, p); err != nil {
					t.Error(err)
				}
			})
		}
		wg.Wait()
		st, err := s.Get(ctx)
		if err != nil {
			t.Fatal(err)
		}
		g := st.General
		if g.HideStartup != on || g.ResumeAfterLogout != on || g.ShowInDock != on || g.LauncherShortcut != tag || st.Updates.SkippedVersion != tag {
			t.Fatalf("round %d lost a change: %v", round, st)
		}
	}
}

func TestUpdateRefuses(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New())
	for _, c := range []struct {
		p     Patch
		field string
	}{
		{Patch{Proxy: &Proxy{URL: "ftp://x"}}, "proxy.url"},
		{Patch{Proxy: &Proxy{URL: "http://x", IgnoredHosts: []string{"a b"}}}, "proxy.ignored_hosts"},
		{Patch{Channel: ptr("nightly")}, "updates.channel"},
		{Patch{TrayIcon: ptr(TrayIcon("TRAY_ICON_PURPLE"))}, "appearance.tray_icon"},
	} {
		_, _, err := s.Update(ctx, c.p)
		var inv *errs.FieldError
		if !errors.As(err, &inv) || inv.Field != c.field {
			t.Errorf("Update(%+v) = %v, want a refusal of %s", c.p, err, c.field)
		}
	}
}

// A refusal's message starts with the setting's path, and the field's description doesn't. Both
// are translated when the page receives them.
func TestRefusalIsTranslated(t *testing.T) {
	_, _, err := New(testdb.Open(t), bus.New()).Update(context.Background(), Patch{Proxy: &Proxy{URL: "ftp://x"}})
	e := errs.Of(err)
	if e == nil || e.Message != "proxy.url: "+badProxyURL || len(e.Fields) != 1 || e.Fields[0].Description != badProxyURL {
		t.Fatalf("the refusal %+v", e)
	}
	i18n.SetLanguage(i18n.Pseudo)
	defer i18n.SetLanguage(i18n.English)
	local := e.Localized()
	if local.Message != "[proxy.url: [múst bé áñ http://, https:// ór sóçks5:// ÚRL wíth á hóst]]" ||
		local.Fields[0].Description != "[múst bé áñ http://, https:// ór sóçks5:// ÚRL wíth á hóst]" {
		t.Errorf("translated %q, %q", local.Message, local.Fields[0].Description)
	}
}

// TestCorruptSettingsDocumentStillFails checks that a document that can't be read isn't replaced
// by the defaults, because the next Update would then write over it.
func TestCorruptSettingsDocumentStillFails(t *testing.T) {
	ctx := context.Background()
	d := testdb.Open(t)
	s := New(d, bus.New())
	if err := d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO settings (id, doc, updated_at) VALUES (1, ?, 0)`, `{"proxy":`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx); err == nil {
		t.Error("a corrupt document read")
	}
	if _, _, err := s.Update(ctx, Patch{Channel: ptr("beta")}); err == nil {
		t.Error("an update wrote over a corrupt document")
	}
}

// TestTelemetryChoice checks the user's choice about sharing usage data: where it starts, and the
// id that the data is sent under while it is on.
func TestTelemetryChoice(t *testing.T) {
	if TelemetryDefault("linux") || !TelemetryDefault("darwin") || !TelemetryDefault("windows") {
		t.Fatal("sharing starts on everywhere but on Linux")
	}
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New())
	var seen []Telemetry
	s.OnChange(func(st Settings) { seen = append(seen, st.Telemetry) })

	on, _, err := s.Update(ctx, Patch{TelemetryEnabled: ptr(true)})
	if err != nil || !on.Telemetry.Enabled || on.Telemetry.ID == "" {
		t.Fatalf("turned on: %+v %v", on.Telemetry, err)
	}
	if again, _, _ := s.Update(ctx, Patch{HideStartup: ptr(true)}); again.Telemetry.ID != on.Telemetry.ID {
		t.Fatal("the id changed with another setting")
	}
	off, _, _ := s.Update(ctx, Patch{TelemetryEnabled: ptr(false)})
	if off.Telemetry.Enabled || off.Telemetry.ID != "" {
		t.Fatalf("turned off: %+v", off.Telemetry)
	}
	back, _, _ := s.Update(ctx, Patch{TelemetryEnabled: ptr(true)})
	if back.Telemetry.ID == "" || back.Telemetry.ID == on.Telemetry.ID {
		t.Fatalf("turned on again: id %q, was %q: want a new one", back.Telemetry.ID, on.Telemetry.ID)
	}
	if len(seen) != 4 || seen[3] != back.Telemetry {
		t.Fatalf("the change hook saw %d changes, the last %+v", len(seen), seen[len(seen)-1])
	}
}

// TestTurningOnOnLinux checks that on Linux, where sharing starts off, turning it on makes the id
// that the data is sent under.
func TestTurningOnOnLinux(t *testing.T) {
	st := Defaults()
	st.Telemetry = Telemetry{Enabled: TelemetryDefault("linux")}
	Patch{TelemetryEnabled: ptr(true)}.apply(&st)
	if !st.Telemetry.Enabled || st.Telemetry.ID == "" {
		t.Fatalf("%+v", st.Telemetry)
	}
}
