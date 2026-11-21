package notifications

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/internal/syncx"
)

// A desktop notification shows the payload's message, redacted as the targets get it, unless
// the caller gives its own text.
func TestDesktopNotifyOS(t *testing.T) {
	failed := MountFailed{Source: ":s3,secret_access_key=hush:photos", Destination: "/mnt/p", Error: "boom"}
	got := Desktop{Route: "/mounts"}.NotifyOS(NotificationEventMountFailed, failed)
	if got.EventID != "mount.failed" || got.Title != "Mount failed" || got.Route != "/mounts" || got.ToastOnly {
		t.Errorf("from the payload: %+v", got)
	}
	if want := "Failed to mount :s3,secret_access_key=***:photos: boom"; got.Body != want {
		t.Errorf("body %q, want %q", got.Body, want)
	}
	own := Desktop{Title: "Automount failed", Body: "boom", ToastOnly: true}.NotifyOS(NotificationEventMountFailed, failed)
	if own != (bus.NotifyOSData{EventID: "mount.failed", Title: "Automount failed", Body: "boom", ToastOnly: true}) {
		t.Errorf("its own text: %+v", own)
	}
	if none := (Desktop{Title: "Automount may look empty"}).NotifyOS(NotificationEventMountFailed, nil); none.Title != "Automount may look empty" {
		t.Errorf("without a payload: %+v", none)
	}
}

// A desktop notification asked for before the UI subscribes to the bus is held, and shown in
// order once it does. Later ones are shown at once.
func TestDesktopWaitsForTheUI(t *testing.T) {
	b := bus.New()
	ctx, stop := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	t.Cleanup(func() { stop(); wg.Wait() })
	s := New(nil, nil, b, nil, syncx.RunnerFunc(func(_ string, fn func(context.Context)) {
		wg.Go(func() { fn(ctx) })
	}))
	s.Start()
	s.Desktop(ctx, NotificationEventJobFailed, nil, Desktop{Title: "first"})
	s.Desktop(ctx, NotificationEventJobFailed, nil, Desktop{Title: "second"})

	sub := b.Subscribe()
	t.Cleanup(sub.Close)
	var titles []string
	for len(titles) < 2 {
		select {
		case ev := <-sub.C:
			titles = append(titles, ev.Data.(bus.NotifyOSData).Title)
		case <-time.After(5 * time.Second):
			t.Fatalf("shown %v, want the two held ones", titles)
		}
	}
	s.Desktop(ctx, NotificationEventJobFailed, nil, Desktop{Title: "third"})
	select {
	case ev := <-sub.C:
		titles = append(titles, ev.Data.(bus.NotifyOSData).Title)
	case <-time.After(5 * time.Second):
		t.Fatal("a later one was not shown")
	}
	if !slices.Equal(titles, []string{"first", "second", "third"}) {
		t.Errorf("shown %v", titles)
	}
}
