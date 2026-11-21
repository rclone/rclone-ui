package app

import (
	"encoding/json"
	"log/slog"
	"slices"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

func TestUnshownToastFallsBack(t *testing.T) {
	var dialogs []string
	// The notifier was never started, so the OS shows no toasts.
	n := &notifier{log: slog.New(slog.DiscardHandler), dialog: func(title, _ string) { dialogs = append(dialogs, title) }}
	n.send("Copied!", "Serve details copied to clipboard")
	n.show(toast{title: "Mount failed", body: "photos: no such remote"})
	n.show(toast{title: "Copy finished", body: "Photos → gdrive:Photos", route: "/history?id=t1", toastOnly: true})
	if want := []string{"Copied!", "Mount failed"}; !slices.Equal(dialogs, want) {
		t.Fatalf("dialogs %q, want %q", dialogs, want)
	}
}

// TestToastRoute passes the toast's data through JSON, as macOS and Windows do before they pass
// it back with a click.
func TestToastRoute(t *testing.T) {
	o := toast{title: "Copy finished", route: "/history?id=t1"}.options()
	if o.ID == "" || o.Title != "Copy finished" {
		t.Fatalf("options %+v", o)
	}
	raw, err := json.Marshal(o.Data)
	if err != nil {
		t.Fatal(err)
	}
	var info map[string]any
	if err := json.Unmarshal(raw, &info); err != nil {
		t.Fatal(err)
	}
	click := notifications.NotificationResponse{ActionIdentifier: notifications.DefaultActionIdentifier, UserInfo: info}
	if route, ok := clickedRoute(click); !ok || route != "/history?id=t1" {
		t.Fatalf("clicked: %q, %v", route, ok)
	}

	if o := (toast{title: "Mount failed"}).options(); o.Data != nil {
		t.Errorf("a toast without a route carries %v", o.Data)
	}
	button := click
	button.ActionIdentifier = "stop"
	for name, r := range map[string]notifications.NotificationResponse{
		"a button":           button,
		"no route":           {ActionIdentifier: notifications.DefaultActionIdentifier},
		"a route not a text": {ActionIdentifier: notifications.DefaultActionIdentifier, UserInfo: map[string]any{routeKey: 42.0}},
		"a URL elsewhere":    {ActionIdentifier: notifications.DefaultActionIdentifier, UserInfo: map[string]any{routeKey: "https://example.com"}},
	} {
		if route, ok := clickedRoute(r); ok {
			t.Errorf("%s opens %q", name, route)
		}
	}
}

func TestAppRoute(t *testing.T) {
	for _, ok := range []string{"/", "/history", "/history?id=t1", "/settings?tab=about#x"} {
		if !appRoute(ok) {
			t.Errorf("appRoute(%q) refused it", ok)
		}
	}
	for _, bad := range []string{
		"",
		"transfers",
		"https://example.com/transfers",
		"//example.com/transfers",
		`/\example.com/transfers`,
		"javascript:alert(1)",
		"/transfers\n?id=t1",
	} {
		if appRoute(bad) {
			t.Errorf("appRoute(%q) accepted it", bad)
		}
	}
}
