package app

import (
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/app/update"
	"github.com/rclone/rclone-ui/core/i18n"
)

func TestReleaseFor(t *testing.T) {
	for _, c := range []struct {
		name, current, found, asked string
		pol                         update.Policy
		offered, required, recom    bool
	}{
		{name: "newer", current: "4.0.1", found: "4.0.2", offered: true},
		{name: "the same", current: "4.0.2", found: "4.0.2"},
		{name: "older", current: "4.0.2", found: "4.0.1"},
		{name: "older, asked for", current: "4.0.2", found: "4.0.1", asked: "4.0.1", offered: true},
		{name: "the same, asked for", current: "4.0.2", found: "4.0.2", asked: "4.0.2", offered: true},
		{name: "a development build", current: "dev", found: "4.0.2", offered: true},
		{name: "below the minimum", current: "4.0.1", found: "4.0.3", pol: update.Policy{Minimum: "4.0.2", Recommended: "4.0.3"}, offered: true, required: true, recom: true},
		{name: "below the minimum only", current: "4.0.1", found: "4.0.3", pol: update.Policy{Minimum: "4.0.2"}, offered: true, required: true, recom: true},
		{name: "below the recommended version", current: "4.0.1", found: "4.0.3", pol: update.Policy{Minimum: "4.0.0", Recommended: "4.0.2"}, offered: true, recom: true},
		{name: "at the recommended version", current: "4.0.2", found: "4.0.3", pol: update.Policy{Minimum: "4.0.0", Recommended: "4.0.2"}, offered: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			found := &update.Release{Version: c.found, Current: c.current, Rclone: "v1.76.2", Notes: "notes", Policy: c.pol}
			rel := releaseFor(found, c.asked)
			if (rel != nil) != c.offered {
				t.Fatalf("offered %v, want %v", rel != nil, c.offered)
			}
			if rel == nil {
				return
			}
			if rel.Required != c.required || rel.Recommended != c.recom {
				t.Errorf("required %v, recommended %v; want %v, %v", rel.Required, rel.Recommended, c.required, c.recom)
			}
			if rel.Version != c.found || rel.Current != c.current || rel.Rclone != "v1.76.2" || rel.Notes != "notes" {
				t.Errorf("release = %+v", rel)
			}
			if want := "https://github.com/rclone/rclone-ui/releases/tag/v" + c.found; rel.Page != want {
				t.Errorf("page %q, want %q", rel.Page, want)
			}
		})
	}
}

func TestUpdateAvailability(t *testing.T) {
	for _, c := range []struct {
		enabled    bool
		installed  update.InstallType
		ok, manual bool
		why        string
	}{
		{true, update.TypeNSIS, true, false, ""},
		{true, update.TypePortable, false, true, update.PortableNote},
		{true, update.TypeUnmanaged, false, false, "No installer put"},
		{true, update.TypeFlatpak, false, false, "Flathub"},
		{false, update.TypePortable, false, false, "not available in this build"},
	} {
		f := &updateFlow{enabled: c.enabled, engine: update.Options{Installed: c.installed}}
		a := f.available()
		if a.OK != c.ok || a.Manual != c.manual || !strings.Contains(a.Why, c.why) {
			t.Errorf("%s (enabled %v): %+v, want ok %v, manual %v, why %q", c.installed, c.enabled, a, c.ok, c.manual, c.why)
		}
	}
}

func TestQuitWaitsForInstall(t *testing.T) {
	f := &updateFlow{}
	f.installing.Lock() // an install, between the core's stop and the exit
	held := make(chan func())
	go func() { held <- f.holdInstalls() }()
	for deadline := time.Now().Add(5 * time.Second); !f.quitWaiting.Load(); time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the quit didn't say it waits")
		}
	}
	select {
	case <-held:
		t.Fatal("the quit went on during the install")
	case <-time.After(50 * time.Millisecond):
	}
	f.installing.Unlock() // the install failed, so the app keeps running and the quit goes on
	release := <-held
	if f.quitWaiting.Load() {
		t.Error("the quit still says it waits")
	}
	if f.installing.TryLock() {
		t.Fatal("an install could start during the quit")
	}
	release()
	if !f.installing.TryLock() {
		t.Fatal("the quit kept installs off after it")
	}

	// In the UI's tests there is no update flow, so holdInstalls must work on nil.
	var none *updateFlow
	none.holdInstalls()()
}

// The update flow translates the engine's errors and reasons. The engine's own text stays in
// English, because `rcui update` prints it.
func TestUpdateTextIsTranslated(t *testing.T) {
	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	got := stepDownload.failure(update.ErrNoArtifact)
	if !strings.HasPrefix(got, "[Rçlóñé ÚÍ çóúld ñót dówñlóád thé úpdáté: [thé réléásé hás ñó dówñlóád fór thís plátfórm]") {
		t.Errorf("failure: %q", got)
	}
	if want := "the release has no download for this platform"; update.ErrNoArtifact.Error() != want {
		t.Errorf("the engine's error became %q", update.ErrNoArtifact.Error())
	}
	f := &updateFlow{enabled: true, engine: update.Options{Installed: update.TypePortable}}
	if a := f.available(); !strings.HasPrefix(a.Why, "[Thís ís á pórtáblé çópý") {
		t.Errorf("why: %q", a.Why)
	}
	if _, why := update.New(update.Options{Installed: update.TypePortable}).CanSelfUpdate(); why != update.PortableNote {
		t.Errorf("the command line's reason became %q", why)
	}
}

func TestLinkQuestion(t *testing.T) {
	for _, c := range []struct{ current, asked, want string }{
		{"4.0.1", "4.0.2", "update from version 4.0.1 to 4.0.2."},
		{"4.1.0", "4.0.0", "change from version 4.1.0 to 4.0.0, an older version."},
		{"4.1.0-beta.2", "4.1.0-beta.1", "an older version"},
		{"4.0.2", "4.0.2", "install version 4.0.2 again."},
	} {
		title, msg := linkQuestion(&UpdateRelease{Version: c.asked, Current: c.current})
		if title != "Update Available" || !strings.Contains(msg, c.want) || !strings.Contains(msg, "rcui update") {
			t.Errorf("%s to %s: %q, %q; want %q", c.current, c.asked, title, msg, c.want)
		}
	}
}
