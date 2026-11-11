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
