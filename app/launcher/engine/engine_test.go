package engine

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"testing"
)

type streamer struct{ release chan struct{} }

func (streamer) Query(context.Context, Query, *Data) []Result { return nil }

func (s streamer) QueryStream(ctx context.Context, _ Query, _ *Data, partial func([]Result)) []Result {
	one := []Result{{ID: "s:1", Title: "one"}}
	partial(one)
	select {
	case <-ctx.Done():
		return nil
	case <-s.release:
	}
	return append(one, Result{ID: "s:2", Title: "two"})
}

// TestRunStreams: a Streamer's partial results are sent in a snapshot before its final ones.
func TestRunStreams(t *testing.T) {
	s := streamer{release: make(chan struct{})}
	var early, last []string
	released := false
	New(s).Run(context.Background(), Query{}, &Data{}, nil, func(rs []Result, final bool) {
		titles := make([]string, len(rs))
		for i, r := range rs {
			titles[i] = r.Title
		}
		switch {
		case final:
			last = titles
		case len(rs) == 1 && !released:
			early, released = titles, true
			close(s.release)
		}
	})
	if !slices.Equal(early, []string{"one"}) || !slices.Equal(last, []string{"one", "two"}) {
		t.Fatalf("early %q, last %q", early, last)
	}
}

type fixed []Result

func (f fixed) Query(context.Context, Query, *Data) []Result { return f }

type broken struct{}

func (broken) Query(context.Context, Query, *Data) []Result { panic("a provider broke") }

type brokenStreamer struct{}

func (brokenStreamer) Query(context.Context, Query, *Data) []Result { return nil }

func (brokenStreamer) QueryStream(_ context.Context, _ Query, _ *Data, partial func([]Result)) []Result {
	partial([]Result{{ID: "half", Title: "half"}})
	panic("a listing broke")
}

// TestAProviderThatPanics: a provider's panic is reported and it returns no results. The other
// providers still answer the query, up to its final snapshot.
func TestAProviderThatPanics(t *testing.T) {
	e := New(fixed{{ID: "ok", Title: "ok"}}, broken{}, brokenStreamer{})
	var reported []string
	var mu sync.Mutex
	e.Panicked = func(where string, v any) {
		mu.Lock()
		reported = append(reported, where+": "+fmt.Sprint(v))
		mu.Unlock()
	}
	var last []string
	done := false
	e.Run(context.Background(), Query{}, &Data{}, nil, func(rs []Result, final bool) {
		last, done = nil, final
		for _, r := range rs {
			last = append(last, r.Title)
		}
	})
	if !done || !slices.Equal(last, []string{"ok"}) {
		t.Fatalf("final %v: %q", done, last)
	}
	mu.Lock()
	defer mu.Unlock()
	slices.Sort(reported)
	want := []string{"provider engine.broken: a provider broke", "provider engine.brokenStreamer: a listing broke"}
	if !slices.Equal(reported, want) {
		t.Errorf("reported %q", reported)
	}
}
