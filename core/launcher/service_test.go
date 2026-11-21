package launcher

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/rclone"
)

// clock is a test clock that the test moves forward by hand.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newService(t *testing.T) (*Service, *clock) {
	t.Helper()
	c := &clock{t: time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)}
	s := New(testdb.Open(t))
	s.now = c.now
	return s, c
}

func usage(t *testing.T, s *Service) map[string]*Usage {
	t.Helper()
	list, err := s.Usage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]*Usage{}
	for _, u := range list {
		out[u.Key] = u
	}
	return out
}

func keys(t *testing.T, s *Service) []string {
	t.Helper()
	list, err := s.Usage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, u := range list {
		out = append(out, u.Key)
	}
	return out
}

func TestRecordAndUsage(t *testing.T) {
	ctx := context.Background()
	s, c := newService(t)
	first := c.t
	for _, q := range []string{"  co ", "", "copy", "co", "c", "cop", "copy to", "sync"} {
		if err := s.Record(ctx, "action:copy", q); err != nil {
			t.Fatal(err)
		}
		c.t = c.t.Add(time.Minute)
	}
	if err := s.Record(ctx, "remote:local:gdrive", "gd"); err != nil {
		t.Fatal(err)
	}

	u := usage(t, s)
	cp := u["action:copy"]
	if cp == nil || cp.Count != 8 {
		t.Fatalf("action:copy %v", cp)
	}
	// The queries are trimmed, the empty one is not kept, a repeated query moves to the front,
	// and only the last five are kept, newest first.
	if want := []string{"sync", "copy to", "cop", "c", "co"}; !slices.Equal(cp.Queries, want) {
		t.Errorf("queries %q, want %q", cp.Queries, want)
	}
	if got, want := time.UnixMilli(cp.LastUsed), first.Add(7*time.Minute); !got.Equal(want) {
		t.Errorf("last used %v, want %v", got, want)
	}
	if gd := u["remote:local:gdrive"]; gd == nil || gd.Count != 1 || !slices.Equal(gd.Queries, []string{"gd"}) {
		t.Errorf("remote:local:gdrive %v", gd)
	}
	// The most recently used key comes first.
	if got := keys(t, s); !slices.Equal(got, []string{"remote:local:gdrive", "action:copy"}) {
		t.Errorf("order %v", got)
	}

	// With only the empty query, the use is counted but no query is kept.
	if err := s.Record(ctx, "action:mount", ""); err != nil {
		t.Fatal(err)
	}
	if m := usage(t, s)["action:mount"]; m == nil || m.Count != 1 || len(m.Queries) != 0 {
		t.Errorf("action:mount %v", m)
	}
}

func TestRecordRefusesNoKey(t *testing.T) {
	s, _ := newService(t)
	for _, key := range []string{"", "  "} {
		err := s.Record(context.Background(), key, "x")
		if errs.FieldOf(err) != "key" {
			t.Errorf("Record(%q) = %v, want a refusal of key", key, err)
		}
	}
	// The pages get the error with the Invalid code.
	err := NewAPI(late.Of(s)).Record(context.Background(), "", "x")
	if rclone.ErrorOf(err).Code != errs.CodeInvalid {
		t.Errorf("API: %v", err)
	}
	if got := keys(t, s); len(got) != 0 {
		t.Errorf("recorded %v", got)
	}
}

func TestForget(t *testing.T) {
	ctx := context.Background()
	s, _ := newService(t)
	for _, k := range []string{"a", "b", "c"} {
		if err := s.Record(ctx, k, k); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Forget(ctx, "b"); err != nil {
		t.Fatal(err)
	}
	if err := s.Forget(ctx, "nowhere"); err != nil {
		t.Fatal(err)
	}
	if got := keys(t, s); len(got) != 2 || slices.Contains(got, "b") {
		t.Errorf("after forgetting b: %v", got)
	}
	if err := NewAPI(late.Of(s)).Forget(ctx, ""); err != nil {
		t.Fatal(err)
	}
	if got := keys(t, s); len(got) != 0 {
		t.Errorf("after forgetting everything: %v", got)
	}
}

func TestPrune(t *testing.T) {
	ctx := context.Background()
	s, c := newService(t)
	start := c.t
	if err := s.Record(ctx, "old", "o"); err != nil {
		t.Fatal(err)
	}
	c.t = start.Add(keepFor - time.Hour)
	if err := s.Record(ctx, "recent", "r"); err != nil {
		t.Fatal(err)
	}
	c.t = start.Add(keepFor + time.Minute)
	if err := s.Prune(ctx); err != nil {
		t.Fatal(err)
	}
	if got := keys(t, s); !slices.Equal(got, []string{"recent"}) {
		t.Errorf("after 90 days: %v", got)
	}

	// Beyond maxKeys, the oldest keys are deleted.
	if err := s.db.Write(ctx, func(tx *sql.Tx) error {
		for i := range maxKeys + 10 {
			if _, err := tx.ExecContext(ctx, `INSERT INTO launcher_usage (key, count, last_used) VALUES (?, 1, ?)`,
				fmt.Sprintf("k%04d", i), c.t.Add(time.Duration(i)*time.Second).UnixMilli()); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.Prune(ctx); err != nil {
		t.Fatal(err)
	}
	got := keys(t, s)
	if len(got) != maxKeys || got[0] != fmt.Sprintf("k%04d", maxKeys+9) || got[len(got)-1] != "k0010" || slices.Contains(got, "recent") {
		t.Errorf("after the cap: %d keys, newest %q, oldest %q", len(got), got[0], got[len(got)-1])
	}
}

// A queries column that isn't a JSON array is read as no queries, and the next Record rewrites it.
func TestBadQueries(t *testing.T) {
	ctx := context.Background()
	s, _ := newService(t)
	if err := s.db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO launcher_usage (key, count, last_used, queries) VALUES ('k', 3, 1, 'nope')`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if u := usage(t, s)["k"]; u == nil || u.Count != 3 || len(u.Queries) != 0 {
		t.Errorf("before: %v", u)
	}
	if err := s.Record(ctx, "k", "q"); err != nil {
		t.Fatal(err)
	}
	if u := usage(t, s)["k"]; u.Count != 4 || !slices.Equal(u.Queries, []string{"q"}) {
		t.Errorf("after: %v", u)
	}
}

func TestAPIUsage(t *testing.T) {
	ctx := context.Background()
	s, _ := newService(t)
	a := NewAPI(late.Of(s))
	if err := a.Record(ctx, "k", "q"); err != nil {
		t.Fatal(err)
	}
	u, err := a.Usage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(u) != 1 || u[0].Key != "k" || u[0].Count != 1 {
		t.Errorf("usage %v", u)
	}
	if err := s.Record(ctx, "", ""); !errors.Is(err, ErrNoKey) {
		t.Errorf("no key: %v", err)
	}
}
