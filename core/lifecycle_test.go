package core

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/internal/syncx"
)

// A one-shot goroutine that panics is recovered and not run again, because a boot run twice would
// start the same mounts twice. A loop that panics is started again.
func TestGoOnceRunsOnce(t *testing.T) {
	c := &Core{backoff: children.Backoff{Min: time.Millisecond, Max: time.Millisecond, Reset: time.Minute}}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	defer c.cancel()

	var once, loop atomic.Int32
	c.GoOnce("boot", func(context.Context) {
		once.Add(1)
		panic("a boot that fails")
	})
	c.Go("loop", func(context.Context) {
		if loop.Add(1) < 3 {
			panic("a loop that fails twice")
		}
	})
	if !syncx.Wait(context.Background(), &c.goes, 5*time.Second) {
		t.Fatal("the goroutines didn't end")
	}
	if n := once.Load(); n != 1 {
		t.Errorf("the one-shot ran %d times", n)
	}
	if n := loop.Load(); n != 3 {
		t.Errorf("the loop ran %d times", n)
	}
}
