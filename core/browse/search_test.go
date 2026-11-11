package browse

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/operations"
)

var searchTree = map[string]string{
	"docs/Report.txt":         "1",
	"docs/report-old.md":      "2",
	"docs/.hidden/report.txt": "3",
	"docs/.report-draft":      "4",
	".git/report":             "5",
	"notes/REPORTS/x.txt":     "6",
	"a/b/c/deep-report.log":   "7",
	"other.txt":               "8",
	"reportless/":             "",
}

func search(t *testing.T, fsName, dir, term string) (found []string, emits int, err error) {
	t.Helper()
	err = Search(context.Background(), fsName, dir, term, SearchWalkMax, false, func(e []Entry) {
		emits++
		found = append(found, paths(e)...)
	})
	slices.Sort(found)
	return found, emits, err
}

func TestSearchMatching(t *testing.T) {
	fx := &Fixture{Inner: MakeTree(t, searchTree)}
	root := AddFixture(fx)
	for _, tc := range []struct {
		name, dir, term string
		want            []string
	}{
		{"name contains the term, case ignored; nothing under or named with a dot", "", "report",
			[]string{"a/b/c/deep-report.log", "docs/Report.txt", "docs/report-old.md", "notes/REPORTS", "reportless"}},
		{"the term's case does not matter either", "docs", "REPORT", []string{"docs/Report.txt", "docs/report-old.md"}},
		{"the leaf only, not the folders above it", "notes", "notes", nil},
		{"within a dot folder the page opened, what is below it", ".git", "rep", []string{".git/report"}},
		{"a dir with slashes", "/docs/", "old", []string{"docs/report-old.md"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, _, err := search(t, root, tc.dir, tc.term)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("found %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSearchEmitsAsItWalks(t *testing.T) {
	fx := &Fixture{Inner: MakeTree(t, searchTree)}
	found, emits, err := search(t, AddFixture(fx), "", "report")
	if err != nil || len(found) != 5 || emits < 3 {
		t.Fatalf("%d matches in %d emits, %v: want them folder by folder", len(found), emits, err)
	}
}

func TestSearchThroughTheBackendsListR(t *testing.T) {
	ctx := context.Background()
	f, err := cache.Get(ctx, ":memory:search-listr")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"x/Match-1", "x/y/match-2", "x/.no/match", "x/other"} {
		if _, err := operations.Rcat(ctx, f, name, io.NopCloser(strings.NewReader("m")), time.Now(), nil); err != nil {
			t.Fatal(err)
		}
	}
	if f.Features().ListR == nil {
		t.Fatal("memory has no ListR any more: this test needs a backend with one")
	}
	got, _, err := search(t, ":memory:search-listr", "x", "MATCH")
	if err != nil || !slices.Equal(got, []string{"x/Match-1", "x/y/match-2"}) {
		t.Fatalf("%q %v", got, err)
	}
}

// TestSearchStopsAfterItsWalkMax checks that the walk ends after max entries, matching or not,
// without an error, and keeps the matches it found until then.
func TestSearchStopsAfterItsWalkMax(t *testing.T) {
	ctx := context.Background()
	f, err := cache.Get(ctx, ":memory:search-walkmax")
	if err != nil {
		t.Fatal(err)
	}
	for i := range 10 {
		name := fmt.Sprintf("x/match-%d", i)
		if _, err := operations.Rcat(ctx, f, name, io.NopCloser(strings.NewReader("m")), time.Now(), nil); err != nil {
			t.Fatal(err)
		}
	}
	var found []string
	err = Search(ctx, ":memory:search-walkmax", "x", "match", 3, false, func(e []Entry) { found = append(found, paths(e)...) })
	if !errors.Is(err, ErrWalkMax) || len(found) != 3 {
		t.Fatalf("%q %v: want 3 matches and ErrWalkMax", found, err)
	}
}

// TestSearchIgnoresTheUnicodeForm checks that a term typed in composed form (NFC) finds a name
// stored in decomposed form (NFD, as macOS names files), and the other way round.
func TestSearchIgnoresTheUnicodeForm(t *testing.T) {
	ctx := context.Background()
	f, err := cache.Get(ctx, ":memory:search-nfc")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"café.txt", "Naïve.txt"} {
		if _, err := operations.Rcat(ctx, f, name, io.NopCloser(strings.NewReader("m")), time.Now(), nil); err != nil {
			t.Fatal(err)
		}
	}
	for term, want := range map[string]string{"café": "café.txt", "CAFÉ": "café.txt", "naïve": "Naïve.txt"} {
		if got, _, err := search(t, ":memory:search-nfc", "", term); err != nil || !slices.Equal(got, []string{want}) {
			t.Errorf("%q: %q %v", term, got, err)
		}
	}
}

func TestSearchStopsWithItsContext(t *testing.T) {
	entered := make(chan struct{}, 1)
	fx := &Fixture{Inner: MakeTree(t, searchTree), Hook: func(ctx context.Context, dir string) error {
		if dir == "a/b" {
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
	start := time.Now()
	err := Search(ctx, AddFixture(fx), "", "report", SearchWalkMax, false, func([]Entry) {})
	if !errors.Is(err, context.Canceled) || time.Since(start) > 5*time.Second {
		t.Fatalf("err %v after %v", err, time.Since(start))
	}
}
