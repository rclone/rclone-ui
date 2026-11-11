//go:build darwin

package darwin

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// TestLateDetectionIsItsOwn checks that a detection which replies after its peek gave up isn't
// taken as the reply to the next peek.
func TestLateDetectionIsItsOwn(t *testing.T) {
	clipOnce.Do(clipSetup)
	if webURL == 0 {
		t.Skip("no pasteboard detection before macOS 15.4")
	}
	autoreleased(func() {
		link := msg(class("NSSet"), "setWithObject:", webURL)
		var late objc.Block
		if detect(func(done objc.Block) { late = done.Copy() }) {
			t.Fatal("found a link with no answer")
		}
		defer late.Release()
		if !detect(func(done objc.Block) { done.Invoke(link, objc.ID(0)) }) {
			t.Fatal("a link answered isn't found")
		}
		got := detect(func(done objc.Block) {
			late.Invoke(link, objc.ID(0)) // the first peek's late reply, which found a link
			done.Invoke(objc.ID(0), objc.ID(0))
		})
		if got {
			t.Error("the earlier peek's answer was taken for this one's")
		}
	})
}

// TestAutoreleasedStaysOnOneThread checks that a goroutine which blocks inside the pool, while
// other goroutines keep the scheduler busy, pops the pool on the thread that pushed it.
func TestAutoreleasedStaysOnOneThread(t *testing.T) {
	lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		t.Fatal(err)
	}
	var threadID func(thread uintptr, id *uint64) int32
	purego.RegisterLibFunc(&threadID, lib, "pthread_threadid_np")
	current := func() uint64 {
		var id uint64
		if threadID(0, &id) != 0 {
			t.Fatal("pthread_threadid_np failed")
		}
		return id
	}

	ctx, cancel := context.WithCancel(context.Background())
	var busy sync.WaitGroup
	for range 8 {
		busy.Go(func() {
			for ctx.Err() == nil {
				for i := range int(1e5) {
					_ = i * i
				}
			}
		})
	}
	defer func() {
		cancel()
		busy.Wait()
	}()

	for i := range 50 {
		var before, after uint64
		autoreleased(func() {
			before = current()
			time.Sleep(20 * time.Millisecond)
			after = current()
		})
		if before != after {
			t.Fatalf("run %d: the pool was pushed on thread %d and popped on %d", i, before, after)
		}
	}
}
