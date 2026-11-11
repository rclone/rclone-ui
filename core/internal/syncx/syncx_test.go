package syncx

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestWait(t *testing.T) {
	var wg sync.WaitGroup
	if !Wait(context.Background(), &wg, time.Second) {
		t.Error("an empty group was not waited for")
	}
	release := make(chan struct{})
	wg.Go(func() { <-release })
	if Wait(context.Background(), &wg, 10*time.Millisecond) {
		t.Error("a running group was said to be done")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if Wait(ctx, &wg, time.Minute) {
		t.Error("a running group was said to be done after the context ended")
	}
	close(release)
	if !Wait(context.Background(), &wg, time.Minute) {
		t.Error("a finished group was not waited for")
	}
}
