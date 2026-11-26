package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
)

func idsOf(ts []Transfer) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.ID
	}
	return out
}

func TestEndedByState(t *testing.T) {
	f := newFixture(t)
	f.seed("1-open", 1, map[string]any{"state": "running", "ended_ms": nil})
	f.seed("2-done", 2, nil)
	f.seed("3-fail", 3, map[string]any{"state": "failed"})
	f.seed("4-stop", 4, map[string]any{"state": "stopped"})
	f.seed("5-intr", 5, map[string]any{"state": "interrupted"})
	f.seed("6-done", 6, nil)
	ctx := context.Background()
	for state, want := range map[State][]string{
		"":             {"6-done", "5-intr", "4-stop", "3-fail", "2-done"},
		StateCompleted: {"6-done", "2-done"},
		StateFailed:    {"3-fail"},
		StateStopped:   {"5-intr", "4-stop"},
	} {
		page, err := f.s.Ended(ctx, EndedQuery{State: state})
		if err != nil {
			t.Fatal(state, err)
		}
		if got := idsOf(page.Items); !slices.Equal(got, want) {
			t.Errorf("%q: %v, want %v", state, got, want)
		}
	}
	for _, state := range []State{StateRunning, StateQueued, StateInterrupted, "nope"} {
		if _, err := f.s.Ended(ctx, EndedQuery{State: state}); !errors.Is(err, ErrNotAnEnd) {
			t.Errorf("%q: %v, want ErrNotAnEnd", state, err)
		}
	}
}

func TestIDOf(t *testing.T) {
	f := newFixture(t)
	f.seed("1-open", 1, map[string]any{"state": "running", "ended_ms": nil})
	f.seed("2-done", 2, nil)
	for seq, want := range map[int64]string{1: "1-open", 2: "2-done"} {
		if id, err := f.s.IDOf(f.ctx, seq); err != nil || id != want {
			t.Errorf("#%d: %q, %v", seq, id, err)
		}
	}
	if _, err := f.s.IDOf(f.ctx, 3); !errors.Is(err, ErrNotFound) {
		t.Errorf("#3: %v, want ErrNotFound", err)
	}
}

type searchCases struct {
	Transfer Transfer `json:"transfer"`
	Searches []struct {
		Search  string `json:"search"`
		Matches bool   `json:"matches"`
	} `json:"searches"`
}

func TestMatches(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/transfer_search_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases searchCases
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.Searches) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range cases.Searches {
		if got := Matches(cases.Transfer, c.Search); got != c.Matches {
			t.Errorf("%q: %v, want %v", c.Search, got, c.Matches)
		}
	}
}

func TestEndedSearchFillsItsPage(t *testing.T) {
	f := newFixture(t)
	for i := range 30 {
		set := map[string]any{"destination": "other:x"}
		if i%10 == 0 {
			set["destination"] = "gdrive:Photos"
		}
		if i == 25 {
			set["error"] = "Photos: permission denied"
		}
		f.seed(fmt.Sprintf("%d-%02d", 100+i, i), int64(100+i), set)
	}
	ctx := context.Background()
	page, err := f.s.Ended(ctx, EndedQuery{Search: "PHOTOS", Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if got := idsOf(page.Items); !slices.Equal(got, []string{"125-25", "120-20"}) || !page.More {
		t.Fatalf("first page %v more %v", got, page.More)
	}
	page, err = f.s.Ended(ctx, EndedQuery{Search: "photos", Limit: 2, Before: "120-20"})
	if err != nil {
		t.Fatal(err)
	}
	if got := idsOf(page.Items); !slices.Equal(got, []string{"110-10", "100-00"}) || page.More {
		t.Fatalf("second page %v more %v", got, page.More)
	}
	page, _ = f.s.Ended(ctx, EndedQuery{Search: "#107"})
	if got := idsOf(page.Items); !slices.Equal(got, []string{"107-07"}) {
		t.Errorf("by number %v", got)
	}
	page, _ = f.s.Ended(ctx, EndedQuery{Search: "photos", State: StateFailed})
	if len(page.Items) != 0 {
		t.Errorf("failed photos %v", idsOf(page.Items))
	}
}

func TestEndedAfter(t *testing.T) {
	f := newFixture(t)
	f.seed("1-open", 1, map[string]any{"state": "running", "ended_ms": nil})
	f.seed("100-a", 100, map[string]any{"ended_ms": 1000})
	f.seed("101-b", 101, map[string]any{"ended_ms": 1001})
	f.seed("102-c", 102, map[string]any{"ended_ms": 1002})
	f.seed("103-d", 103, map[string]any{"ended_ms": 5000})
	f.seed("104-e", 104, map[string]any{"ended_ms": 1003, "state": "failed"})
	ctx := context.Background()

	page, err := f.s.Ended(ctx, EndedQuery{After: 1001})
	if err != nil {
		t.Fatal(err)
	}
	if got := idsOf(page.Items); !slices.Equal(got, []string{"104-e", "103-d", "102-c", "101-b"}) || page.More {
		t.Errorf("after 1001: %v more %v", got, page.More)
	}
	page, _ = f.s.Ended(ctx, EndedQuery{After: 1001, Limit: 2})
	if got := idsOf(page.Items); !slices.Equal(got, []string{"102-c", "101-b"}) || !page.More {
		t.Errorf("after 1001, 2 of them: %v more %v", got, page.More)
	}
	page, _ = f.s.Ended(ctx, EndedQuery{After: 1001, State: StateFailed})
	if got := idsOf(page.Items); !slices.Equal(got, []string{"104-e"}) {
		t.Errorf("failed after 1001: %v", got)
	}
	page, _ = f.s.Ended(ctx, EndedQuery{After: 5001})
	if len(page.Items) != 0 || page.More {
		t.Errorf("after the last end: %v", idsOf(page.Items))
	}
}

func TestEndedPageSize(t *testing.T) {
	f := newFixture(t)
	for i := range maxPage + 5 {
		f.seed(fmt.Sprintf("%d-x", 1000+i), int64(1000+i), nil)
	}
	ctx := context.Background()
	for _, limit := range []int{0, -1, maxPage + 1, 5000} {
		page, err := f.s.Ended(ctx, EndedQuery{Limit: limit})
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != maxPage || !page.More {
			t.Errorf("limit %d: %d rows, more %v", limit, len(page.Items), page.More)
		}
	}
	if maxPage != 200 {
		t.Errorf("pages of %d, want 200", maxPage)
	}
	page, _ := f.s.Ended(ctx, EndedQuery{Limit: 50})
	if len(page.Items) != 50 {
		t.Errorf("limit 50: %d rows", len(page.Items))
	}
}

func TestDone(t *testing.T) {
	f := newFixture(t)
	began := time.Now().Add(-2 * time.Second)
	started, err := f.s.Done(context.Background(), DoneRequest{
		Form: operations.DeleteArgs{Sources: []string{"gdrive:a/b.txt"}}.Form(), Origin: Origin{Kind: OriginCommander}, Began: began,
	})
	if err != nil {
		t.Fatal(err)
	}
	<-f.saidOf(started.ID)
	d, err := f.s.Get(context.Background(), started.ID)
	if err != nil {
		t.Fatal(err)
	}
	tr := d.Transfer
	if tr.State != StateCompleted || tr.Operation != "delete" || !slices.Equal(tr.Sources, []string{"gdrive:a/b.txt"}) ||
		tr.Origin.Kind != OriginCommander || tr.EndedAt == nil || tr.StartedAt == nil ||
		*tr.StartedAt != began.UnixMilli() || tr.Stats == nil || tr.Stats.DurationMs < 2000 {
		t.Fatalf("recorded %+v", tr)
	}
	if d.Retryable != 0 {
		t.Errorf("%d to retry", d.Retryable)
	}
	if page, _ := f.s.Ended(context.Background(), EndedQuery{Search: "b.txt"}); len(page.Items) != 1 {
		t.Errorf("not listed: %v", idsOf(page.Items))
	}
	f.settled()
	changed := f.published(bus.TransfersChanged)
	if len(changed) != 1 || changed[0].Data.(bus.TransfersChangedData).State != string(StateCompleted) {
		t.Errorf("changes %+v", changed)
	}
	if got := f.toasts(); len(got) != 0 {
		t.Errorf("desktop told %+v", got)
	}
	if got := f.notes.events(started.Seq); !slices.Equal(got, []notifications.NotificationEvent{notifications.NotificationEventJobCompleted}) {
		t.Errorf("notified %v", got)
	}
	if _, err := f.s.Done(context.Background(), DoneRequest{Form: operations.Form{Operation: "nope"}}); err == nil {
		t.Error("an unknown operation recorded")
	}
}

func TestEndRetriesLastAMinute(t *testing.T) {
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second}
	if !slices.Equal(endRetries, want) {
		t.Errorf("waits %v, want %v", endRetries, want)
	}
	if s := New(Options{}); !slices.Equal(s.endWaits, want) {
		t.Errorf("the service waits %v", s.endWaits)
	}
}

func TestRetryEndStopsAtShutdown(t *testing.T) {
	f := newFixture(t)
	f.s.endWaits = []time.Duration{time.Hour, time.Hour}
	waiting := &onMessage{msg: "writing a transfer's end; trying again", seen: make(chan struct{})}
	f.s.log = slog.New(waiting)
	failing := errors.New("disk full")
	tries := 0
	done := make(chan error, 1)
	go func() {
		done <- f.s.retryEnd(context.Background(), func() error { tries++; return failing })
	}()
	select {
	case <-waiting.seen:
	case <-time.After(30 * time.Second):
		t.Fatal("the failed write was not tried again")
	}
	go f.s.Shutdown(context.Background(), false)
	select {
	case err := <-done:
		if !errors.Is(err, failing) || tries != 2 {
			t.Errorf("%d tries, %v", tries, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("still waiting after the shutdown")
	}
}

type onMessage struct {
	msg  string
	seen chan struct{}
	once sync.Once
}

func (h *onMessage) Enabled(context.Context, slog.Level) bool { return true }

func (h *onMessage) Handle(_ context.Context, r slog.Record) error {
	if r.Message == h.msg {
		h.once.Do(func() { close(h.seen) })
	}
	return nil
}

func (h *onMessage) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *onMessage) WithGroup(string) slog.Handler      { return h }
