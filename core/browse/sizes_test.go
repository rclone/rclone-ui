package browse

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSizes(t *testing.T) {
	root := MakeTree(t, map[string]string{
		"a/one":     "0123456789",
		"a/sub/two": "01234567890123456789",
		"b/three":   "abcde",
		"c/":        "",
	})
	var running, most atomic.Int32
	fx := &Fixture{Inner: root, Hook: func(ctx context.Context, dir string) error {
		if dir == "" { // the top of each counted folder: track how many are counted at once
			n := running.Add(1)
			defer running.Add(-1)
			for m := most.Load(); n > m && !most.CompareAndSwap(m, n); m = most.Load() {
			}
			return Sleep(ctx, 50*time.Millisecond)
		}
		return nil
	}}
	var got []Size
	fsName := AddFixture(fx)
	err := Sizes(context.Background(), []string{fsName + "a", fsName + "b", fsName + "c", fsName + "missing", "-bad:x"}, func(s Size) { got = append(got, s) })
	if err != nil {
		t.Fatal(err)
	}
	slices.SortFunc(got, func(x, y Size) int { return strings.Compare(x.Path, y.Path) })
	want := []Size{{Path: fsName + "a", Files: 2, Bytes: 30}, {Path: fsName + "b", Files: 1, Bytes: 5}, {Path: fsName + "c"}}
	if !slices.Equal(got, want) {
		t.Errorf("sizes %+v, want %+v (a folder that cannot be counted, or named, is left out)", got, want)
	}
	if most.Load() != 2 {
		t.Errorf("%d folders counted at once, want 2", most.Load())
	}
}

func TestSizesStopWithPartialCounts(t *testing.T) {
	entered := make(chan struct{}, 2)
	fx := &Fixture{Inner: MakeTree(t, map[string]string{
		"big/f1": "1", "big/f2": "22", "big/slow/f3": "333",
		"next/f": "x",
	}), Hook: func(ctx context.Context, dir string) error {
		if dir == "slow" {
			entered <- struct{}{}
			return Sleep(ctx, time.Minute)
		}
		return nil
	}}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-entered
		cancel()
	}()
	var got []Size
	start := time.Now()
	fsName := AddFixture(fx)
	err := Sizes(ctx, []string{fsName + "big"}, func(s Size) { got = append(got, s) })
	if !errors.Is(err, context.Canceled) || time.Since(start) > 5*time.Second {
		t.Fatalf("err %v after %v", err, time.Since(start))
	}
	if len(got) != 1 || got[0] != (Size{Path: fsName + "big", Files: 2, Bytes: 3, Partial: true}) {
		t.Fatalf("got %+v: want what was counted before the stop, marked partial", got)
	}

	// Folders not yet started are not reported.
	got = nil
	ctx, cancel = context.WithCancel(context.Background())
	cancel()
	fsName = AddFixture(fx)
	err = Sizes(ctx, []string{fsName + "big", fsName + "next", fsName + "big/slow"}, func(s Size) { got = append(got, s) })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v", err)
	}
	for _, s := range got {
		if !s.Partial {
			t.Errorf("%+v reported whole after the stop", s)
		}
	}
}
