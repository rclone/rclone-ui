package logs

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/internal/testutil"
)

// symlink is a line from the kind of flood that folding is for. rclone logs this notice for
// every symlink a walk finds, and only the object differs.
func symlink(object string, at time.Time, set ...func(*Record)) Record {
	r := Record{Time: at, Level: LevelNotice, Component: CompRclone, Subcomponent: "local",
		Message: "Can't follow symlink without -L/--copy-links", Source: "local/local.go:1354",
		Object: object, ObjectType: "*local.Object", StatsGroup: "ui/size/3"}
	for _, fn := range set {
		fn(&r)
	}
	return r
}

// feed runs records through f at now, as the writer does, and returns what it writes.
func feed(f *folder, now time.Time, records ...Record) []Record {
	var out []Record
	for _, r := range records {
		write, due := f.line(r, now)
		out = append(out, due...)
		if write {
			out = append(out, r)
		}
	}
	return out
}

// shape is how the folding tests compare written records: a line's object, or a mark's count.
func shape(records []Record) []string {
	out := []string{}
	for _, r := range records {
		switch r.Mark {
		case "":
			out = append(out, r.Object)
		case MarkRepeated:
			out = append(out, fmt.Sprintf("[%d more, last %s]", r.Count, r.Object))
		default:
			out = append(out, "["+r.Mark+"]")
		}
	}
	return out
}

func objects(prefix string, from, to int) []string {
	var out []string
	for i := from; i < to; i++ {
		out = append(out, fmt.Sprintf("%s%d", prefix, i))
	}
	return out
}

func TestFoldingInAndOutOfAWindow(t *testing.T) {
	rules := foldRules{window: time.Minute, quiet: 2 * time.Second, burst: 3, burstLoud: 5, kinds: 10}
	f := newFolder(rules)
	clock := time.Unix(1_790_000_000, 0)
	var lines []Record
	for i := range 10 {
		lines = append(lines, symlink(fmt.Sprintf("a%d", i), clock.Add(time.Duration(i)*time.Millisecond)))
	}
	// The first three are written, and the rest are counted.
	got := shape(feed(f, clock, lines...))
	if want := objects("a", 0, 3); !reflect.DeepEqual(got, want) {
		t.Fatalf("written %q, want %q", got, want)
	}
	if f.pending != 1 {
		t.Errorf("%d kinds pending, want 1", f.pending)
	}
	// Still in the window and not quiet, so nothing is due yet.
	if due := f.sweep(clock.Add(time.Second)); len(due) != 0 {
		t.Errorf("due before the quiet time: %q", shape(due))
	}

	// The window ended. The count comes first, where the window closed, and the kind starts over.
	later := clock.Add(time.Minute)
	got = shape(feed(f, later, symlink("b0", later), symlink("b1", later), symlink("b2", later), symlink("b3", later)))
	if want := []string{"[7 more, last a9]", "b0", "b1", "b2"}; !reflect.DeepEqual(got, want) {
		t.Errorf("after the window %q, want %q", got, want)
	}

	// After the quiet time, the count is written, and the allowance stays used up.
	got = shape(f.sweep(later.Add(2 * time.Second)))
	if want := []string{"b3"}; !reflect.DeepEqual(got, want) {
		t.Errorf("a count of one is its line: %q, want %q", got, want)
	}
	at := later.Add(3 * time.Second)
	got = shape(feed(f, at, symlink("c0", at), symlink("c1", at)))
	if len(got) != 0 {
		t.Errorf("the allowance came back before the window ended: %q", got)
	}
	got = shape(f.sweep(at.Add(2 * time.Second)))
	if want := []string{"[2 more, last c1]"}; !reflect.DeepEqual(got, want) {
		t.Errorf("the second quiet count %q, want %q", got, want)
	}
	// A window that ends with nothing counted writes nothing, and the kind is forgotten.
	if due := f.sweep(later.Add(time.Minute)); len(due) != 0 || len(f.kinds) != 0 || f.pending != 0 {
		t.Errorf("the end of a quiet window: due %q, %d kinds, %d pending", shape(due), len(f.kinds), f.pending)
	}

	// Errors and critical lines have the larger allowance.
	loud := func(i int) Record {
		return symlink(fmt.Sprint("e", i), clock, func(r *Record) { r.Level = slog.LevelError })
	}
	var many []Record
	for i := range 8 {
		many = append(many, loud(i))
	}
	at = later.Add(2 * time.Minute)
	if got := shape(feed(f, at, many...)); !reflect.DeepEqual(got, objects("e", 0, 5)) {
		t.Errorf("errors written %q, want five", got)
	}
	if got := shape(f.all()); !reflect.DeepEqual(got, []string{"[3 more, last e7]"}) {
		t.Errorf("at the end %q", got)
	}
	if len(f.kinds) != 0 || f.pending != 0 || f.order.Len() != 0 {
		t.Errorf("after all: %d kinds, %d pending, %d in order", len(f.kinds), f.pending, f.order.Len())
	}
}

func TestTheRepeatedMark(t *testing.T) {
	f := newFolder(foldRules{window: time.Minute, quiet: time.Second, burst: 1, burstLoud: 1, kinds: 10})
	t0 := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	size := int64(7)
	attributed := func(r *Record) {
		r.Transfer, r.Operation, r.Job = "t1", "copy", 3
		r.Size = &size
		r.Extra = map[string]any{"k": "v"}
	}
	// The folded lines' own times can be out of order, as a child's can. first and last are the
	// earliest and latest times, and the object comes from the newest line.
	records := []Record{
		symlink("kept", t0, attributed),
		symlink("x1", t0.Add(2*time.Second), attributed),
		symlink("x2", t0.Add(1500*time.Millisecond), attributed),
		symlink("x3", t0.Add(5*time.Second), attributed),
		symlink("x4", t0.Add(4*time.Second), attributed),
	}
	feed(f, t0, records...)
	due := f.all()
	if len(due) != 1 {
		t.Fatalf("%d records due: %q", len(due), shape(due))
	}
	want := records[4]
	want.Mark, want.Count, want.Size, want.Time = MarkRepeated, 4, nil, t0.Add(5*time.Second)
	want.Extra = map[string]any{"first": "2026-09-27T10:00:01.500Z", "last": "2026-09-27T10:00:05.000Z"}
	if !reflect.DeepEqual(due[0], want) {
		t.Errorf("the mark\n %+v\nwant\n %+v", due[0], want)
	}
}

func TestKindsAreApart(t *testing.T) {
	f := newFolder(foldRules{window: time.Minute, quiet: time.Second, burst: 1, burstLoud: 1, kinds: 100})
	now := time.Unix(1_790_000_000, 0)
	for _, c := range []struct {
		name  string
		set   func(*Record)
		alike bool
	}{
		{"another object, size, time and extra", func(r *Record) {
			size := int64(9)
			r.Object, r.Size, r.Time, r.Extra = "elsewhere", &size, now.Add(time.Hour), map[string]any{"k": 1}
		}, true},
		{"a level", func(r *Record) { r.Level = slog.LevelWarn }, false},
		{"a component", func(r *Record) { r.Component = CompMounts }, false},
		{"a subcomponent", func(r *Record) { r.Subcomponent = "s3" }, false},
		{"a message", func(r *Record) { r.Message = "Can't follow" }, false},
		{"a source", func(r *Record) { r.Source = "local/local.go:1" }, false},
		{"an object type", func(r *Record) { r.ObjectType = "*local.Fs" }, false},
		{"a stats group", func(r *Record) { r.StatsGroup = "ui/size/4" }, false},
		{"a transfer", func(r *Record) { r.Transfer = "t2" }, false},
		{"a job", func(r *Record) { r.Job = 5 }, false},
		{"an operation", func(r *Record) { r.Operation = "sync" }, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			f.all()
			base, other := symlink("a", now), symlink("a", now, c.set)
			written := feed(f, now, base, other)
			if got := len(written) == 1; got != c.alike {
				t.Errorf("written %q: alike %v, want %v", shape(written), got, c.alike)
			}
		})
	}
}

func TestTheKindCapEvictsTheLeastRecentlySeen(t *testing.T) {
	f := newFolder(foldRules{window: time.Minute, quiet: time.Second, burst: 1, burstLoud: 1, kinds: 3})
	now := time.Unix(1_790_000_000, 0)
	of := func(kind, object string) Record {
		return symlink(object, now, func(r *Record) { r.Message = kind })
	}
	feed(f, now, of("A", "a0"), of("A", "a1"), of("A", "a2"), of("B", "b0"), of("B", "b1"), of("C", "c0"))
	feed(f, now, of("A", "a3")) // A is seen again, so B is now the least recently seen
	got := shape(feed(f, now, of("D", "d0")))
	if want := []string{"b1", "d0"}; !reflect.DeepEqual(got, want) {
		t.Errorf("a fourth kind: %q, want B's count first (a count of one, its line) and then D", got)
	}
	if len(f.kinds) != 3 || f.order.Len() != 3 || f.pending != 1 {
		t.Errorf("%d kinds, %d in order, %d pending; want 3, 3, 1", len(f.kinds), f.order.Len(), f.pending)
	}
	got = shape(feed(f, now, of("E", "e0")))
	if want := []string{"e0"}; !reflect.DeepEqual(got, want) {
		t.Errorf("a fifth kind evicts C, which counted nothing: %q, want %q", got, want)
	}
	if got := shape(f.all()); !reflect.DeepEqual(got, []string{"[3 more, last a3]"}) {
		t.Errorf("at the end %q", got)
	}
	// B starts over when it comes back.
	if got := shape(feed(f, now, of("B", "b2"))); !reflect.DeepEqual(got, []string{"b2"}) {
		t.Errorf("B again: %q", got)
	}
}

func TestZeroRulesFoldNothing(t *testing.T) {
	f := newFolder(foldRules{})
	now := time.Unix(1_790_000_000, 0)
	var records []Record
	for i := range 50 {
		records = append(records, symlink(fmt.Sprint(i), now))
	}
	if got := feed(f, now, records...); len(got) != 50 || len(f.kinds) != 0 {
		t.Errorf("%d written, %d kinds", len(got), len(f.kinds))
	}
}

// accounted returns how many appended lines the records account for: the lines written, plus the
// counts in `repeated` and `dropped` marks.
func accounted(records []Record) (written, folded, dropped int64) {
	for _, r := range records {
		switch r.Mark {
		case "":
			written++
		case MarkRepeated:
			folded += r.Count
		case MarkDropped:
			dropped += r.Count
		}
	}
	return written, folded, dropped
}

func TestTheStopMarkComesAfterTheCounts(t *testing.T) {
	l, stderr := openTest(t, "info", tuningFor(t))
	log := slog.New(l.Handler()).With("component", CompRclone, "subcomponent", "local")
	ctx := With(context.Background(), Transfer("t1"))
	for i := range 50 {
		log.Log(ctx, LevelNotice, "Can't follow symlink without -L/--copy-links", "object", fmt.Sprint("f", i))
	}
	log.WarnContext(ctx, "another kind")
	closeTest(t, l)

	var got []string
	for _, r := range fileRecords(t, l.Path()) {
		switch r.Mark {
		case "":
			got = append(got, r.Message+" "+r.Object)
		case MarkRepeated:
			got = append(got, fmt.Sprintf("[%s %s %s %s %s %d]", r.Mark, LevelWord(r.Level), r.Message, r.Object, r.Transfer, r.Count))
		default:
			got = append(got, "["+r.Mark+"]")
		}
	}
	want := []string{"[start]"}
	for i := range foldBurst {
		want = append(want, fmt.Sprint("Can't follow symlink without -L/--copy-links f", i))
	}
	want = append(want, "another kind ",
		"[repeated notice Can't follow symlink without -L/--copy-links f49 t1 30]", "[stop]")
	if !reflect.DeepEqual(got, want) {
		t.Errorf("records\n%q\nwant\n%q", got, want)
	}
	// stderr is not folded, because it is what the terminal shows.
	if n := len(splitLines(stderr.String())); n != 51 {
		t.Errorf("stderr has %d lines, want 51", n)
	}
}

func splitLines(s string) []string {
	var out []string
	for len(s) > 0 {
		i := 0
		for i < len(s) && s[i] != '\n' {
			i++
		}
		out = append(out, s[:i])
		if i < len(s) {
			i++
		}
		s = s[i:]
	}
	return out
}

func TestAQuietKindIsCountedWhileTheCoreRuns(t *testing.T) {
	tu := tuningFor(t)
	tu.fold = foldRules{window: time.Minute, quiet: 40 * time.Millisecond, burst: 2, burstLoud: 2, kinds: 10}
	l, _ := openTest(t, "info", tu)
	log := slog.New(l.Handler())
	for i := range 7 {
		log.Info("again", "object", fmt.Sprint(i))
	}
	testutil.Eventually(t, 5*time.Second, "the count", func() bool {
		for _, r := range l.Tail(0) {
			if r.Mark == MarkRepeated {
				return r.Object == "6" && r.Message == "again" && r.Count == 5
			}
		}
		return false
	})
	closeTest(t, l)
	if w, f, d := accounted(fileRecords(t, l.Path())); w != 2 || f != 5 || d != 0 {
		t.Errorf("written %d, folded %d, dropped %d; want 2, 5, 0", w, f, d)
	}
}

func TestAFloodIsAFewLines(t *testing.T) {
	const flood = 400_000
	l, _ := openTest(t, "error", tuningFor(t))
	began := time.Now()
	for i := range flood {
		for len(l.queue) > queueSize/2 { // keep pace with the writer, so none drop
			time.Sleep(50 * time.Microsecond)
		}
		l.Append(symlink(fmt.Sprintf("Library/%d", i), time.Now()))
	}
	took := time.Since(began)
	closeTest(t, l)
	records := fileRecords(t, l.Path())
	// Expect the start and stop marks, the allowance, and a count for each window and quiet
	// period during the flood.
	most := 2 + foldBurst + 2 + int(took/foldWindow)*(foldBurst+1) + int(took/foldQuiet)
	if len(records) > most {
		t.Errorf("%d records for %d lines in %s, want at most %d", len(records), flood, took, most)
	}
	if w, f, d := accounted(records); w+f != flood || d != 0 {
		t.Errorf("written %d + folded %d = %d, dropped %d; want %d, 0", w, f, w+f, d, flood)
	}
	t.Logf("%d lines in %s: %d records", flood, took.Round(time.Millisecond), len(records))
}

// TestFoldingUnderAFullQueue checks that the handler never waits, whatever the writer is doing.
// Lines refused by the full queue are counted in a dropped mark, and lines the writer folds are
// counted in a repeated mark.
func TestFoldingUnderAFullQueue(t *testing.T) {
	const size, perGoroutine, goroutines = 1024, 100_000, 4
	tu := tuningFor(t)
	tu.queue = size
	l, _ := openTest(t, "error", tu)
	var wg sync.WaitGroup
	for g := range goroutines {
		wg.Go(func() {
			for i := range perGoroutine {
				l.Append(Record{Level: slog.LevelDebug, Component: CompRclone, Subcomponent: "s3",
					Message: "Unchanged skipping", Object: fmt.Sprint(i), Transfer: fmt.Sprint(g)})
			}
		})
	}
	wg.Wait()
	closeTest(t, l)

	records := fileRecords(t, l.Path())
	w, f, d := accounted(records)
	if w+f+d != goroutines*perGoroutine {
		t.Errorf("written %d + folded %d + dropped %d = %d, want %d", w, f, d, w+f+d, goroutines*perGoroutine)
	}
	if len(records) > 2+goroutines*(foldBurst+1)+int(d) {
		t.Errorf("%d records", len(records))
	}
}
