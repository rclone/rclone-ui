package windows

import (
	"context"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// fakeWindow is a window for the tests. Only the methods that a test calls are implemented.
type fakeWindow struct {
	application.Window
	events []*application.CustomEvent
}

func (w *fakeWindow) DispatchWailsEvent(event *application.CustomEvent) {
	w.events = append(w.events, event)
}

func TestCaller(t *testing.T) {
	if _, ok := Caller(context.Background()); ok {
		t.Fatal("a call from no window has a caller")
	}
	var none application.Window
	if _, ok := Caller(context.WithValue(context.Background(), application.WindowKey, none)); ok {
		t.Fatal("a nil window counts as the caller")
	}
	w := &fakeWindow{}
	got, ok := Caller(context.WithValue(context.Background(), application.WindowKey, application.Window(w)))
	if !ok || got != w {
		t.Fatalf("caller %v, %v", got, ok)
	}
}

func TestRouteGoesToTheWindow(t *testing.T) {
	w := &fakeWindow{}
	route(w, "/templates?action=add")
	if len(w.events) != 1 || w.events[0].Name != EventRoute || w.events[0].Data != "/templates?action=add" {
		t.Fatalf("events %+v", w.events)
	}
}

func TestFit(t *testing.T) {
	for _, c := range []struct {
		scale float64
		area  Area
		w, h  int
		zoom  float64
		name  string
	}{
		{1, Area{Width: 1920, Height: 1040}, 800, 500, 1, "plenty of room"},
		{1.5, Area{Width: 1920, Height: 1040}, 1200, 750, 1, "larger text, still room"},
		{1.5, Area{Width: 1124, Height: 556}, 889, 556, 556.0 / 750, "larger text on a small screen"},
		{1, Area{Width: 640, Height: 400}, 640, 400, 0.8, "a screen smaller than the page"},
		{1, Area{}, 800, 500, 1, "an unknown screen"},
	} {
		w, h, zoom := fit(800, 500, c.scale, c.area)
		if w != c.w || h != c.h || zoom < c.zoom-0.001 || zoom > c.zoom+0.001 {
			t.Errorf("%s: got %dx%d zoom %.3f, want %dx%d zoom %.3f", c.name, w, h, zoom, c.w, c.h, c.zoom)
		}
	}
}
