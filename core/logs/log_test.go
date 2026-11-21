package logs

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/internal/testutil"
)

// syncBuffer stands in for stderr in the tests. Append may write to it from any goroutine.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func tuningFor(t *testing.T) tuning {
	t.Helper()
	return tuning{stderr: &syncBuffer{}, queue: queueSize, fold: folding(), maxSize: maxFileSize, ring: ringSize}
}

// openTest opens a log in a new folder, with stderr lines copied to the buffer it returns.
func openTest(t *testing.T, level string, tu tuning) (*Log, *syncBuffer) {
	t.Helper()
	stderr := &syncBuffer{}
	tu.stderr = stderr
	l, err := open(Options{Path: filepath.Join(t.TempDir(), "logs", "rcui.log"), Stderr: true, Level: level}, tu)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l, stderr
}

func closeTest(t *testing.T, l *Log) {
	t.Helper()
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
}

func fileRecords(t *testing.T, path string) []Record {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	var out []Record
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		var w wire
		dec := json.NewDecoder(bytes.NewReader(sc.Bytes()))
		dec.UseNumber()
		if err := dec.Decode(&w); err != nil {
			t.Fatalf("line %q: %v", sc.Text(), err)
		}
		lvl, ok := levelOf(w.Level)
		tm, err := time.Parse(time.RFC3339Nano, w.Time)
		if !ok || err != nil {
			t.Fatalf("line %q: level %v time %v", sc.Text(), ok, err)
		}
		out = append(out, Record{N: w.N, Time: tm, Level: lvl, Component: w.Component, Subcomponent: w.Subcomponent,
			Message: w.Message, Source: w.Source, Object: w.Object, ObjectType: w.ObjectType, Size: w.Size,
			StatsGroup: w.StatsGroup, Transfer: w.Transfer, Job: w.Job, Operation: w.Operation, Mark: w.Mark,
			Count: w.Count, Extra: w.Extra})
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func lines(records []Record) []Record {
	var out []Record
	for _, r := range records {
		if r.Mark == "" {
			out = append(out, r)
		}
	}
	return out
}

func TestAttributionToColumns(t *testing.T) {
	type columns struct {
		StatsGroup, Transfer, Operation string
		Job                             int64
	}
	for _, c := range []struct {
		name string
		ctx  func() context.Context
		want columns
	}{
		{
			"a transfer's group and job",
			func() context.Context {
				return With(context.Background(), StatsGroup("transfer/t1"), Job(7), Operation("copy"))
			},
			columns{StatsGroup: "transfer/t1", Transfer: "t1", Operation: "copy", Job: 7},
		},
		{
			"With called twice",
			func() context.Context {
				ctx := With(context.Background(), Transfer("t2"), Operation("sync"))
				return With(ctx, Operation("move"), StatsGroup("transfer/other"))
			},
			columns{StatsGroup: "transfer/other", Transfer: "t2", Operation: "move"},
		},
		{
			"a group that is not a transfer's",
			func() context.Context { return With(context.Background(), StatsGroup("ui/list/3")) },
			columns{StatsGroup: "ui/list/3"},
		},
		{"nothing", context.Background, columns{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			l, _ := openTest(t, "debug", tuningFor(t))
			slog.New(l.Handler()).With("component", CompApp, "subcomponent", SubStartup).InfoContext(c.ctx(), "hello")
			closeTest(t, l)
			got := lines(fileRecords(t, l.Path()))
			if len(got) != 1 {
				t.Fatalf("%d lines", len(got))
			}
			r := got[0]
			if have := (columns{r.StatsGroup, r.Transfer, r.Operation, r.Job}); have != c.want {
				t.Errorf("columns %+v, want %+v", have, c.want)
			}
			if r.Component != CompApp || r.Subcomponent != SubStartup {
				t.Errorf("component %s/%s", r.Component, r.Subcomponent)
			}
		})
	}
}

type stringer struct{}

func (stringer) String() string { return "as text" }

func TestAttributesToColumnsAndExtra(t *testing.T) {
	l, _ := openTest(t, "debug", tuningFor(t))
	log := slog.New(l.Handler()).With("component", CompRclone, "k", "v").WithGroup("g")
	log.Warn("with attrs", "a", 1, slog.Group("inner", "b", true))
	slog.New(l.Handler()).Error("columns",
		"subcomponent", "s3", "object", "dir/file.txt", "objectType", "*s3.Object", "size", 42,
		"source", "operations/copy.go:12", "error", errors.New("boom"), "d", 1500*time.Millisecond,
		"s", stringer{}, "m", map[string]int{"x": 1}, slog.Group("", "inlined", "yes"), slog.Attr{})
	closeTest(t, l)
	got := lines(fileRecords(t, l.Path()))
	if len(got) != 2 {
		t.Fatalf("%d lines", len(got))
	}
	if got[0].Component != CompRclone || got[0].Subcomponent != "" || got[0].Level != slog.LevelWarn {
		t.Errorf("first %+v", got[0])
	}
	if want := `{"g":{"a":1,"inner":{"b":true}},"k":"v"}`; jsonOf(t, got[0].Extra) != want {
		t.Errorf("first extra %s, want %s", jsonOf(t, got[0].Extra), want)
	}
	r := got[1]
	if r.Component != CompApp || r.Subcomponent != "s3" || r.Object != "dir/file.txt" || r.ObjectType != "*s3.Object" ||
		r.Size == nil || *r.Size != 42 || r.Source != "operations/copy.go:12" || r.Level != slog.LevelError {
		t.Errorf("second %+v", r)
	}
	if want := `{"d":"1.5s","error":"boom","inlined":"yes","m":{"x":1},"s":"as text"}`; jsonOf(t, r.Extra) != want {
		t.Errorf("second extra %s, want %s", jsonOf(t, r.Extra), want)
	}
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestLevelsAndStderr(t *testing.T) {
	for _, c := range []struct {
		level slog.Level
		word  string
	}{
		{slog.LevelDebug - 4, "debug"}, {slog.LevelDebug, "debug"}, {slog.LevelInfo, "info"}, {LevelNotice, "notice"},
		{slog.LevelWarn, "warning"}, {slog.LevelError, "error"}, {LevelCritical, "critical"}, {LevelCritical + 8, "critical"},
	} {
		if got := LevelWord(c.level); got != c.word {
			t.Errorf("LevelWord(%v) = %q, want %q", c.level, got, c.word)
		}
		if back, err := ParseLevel(c.word); err != nil || LevelWord(back) != c.word {
			t.Errorf("ParseLevel(%q) = %v, %v", c.word, back, err)
		}
	}
	if _, err := ParseLevel("loud"); err == nil {
		t.Error("ParseLevel took an unknown name")
	}
	if _, err := Open(Options{Path: filepath.Join(t.TempDir(), "x.log"), Level: "loud"}); err == nil {
		t.Error("Open took an unknown level")
	}

	l, stderr := openTest(t, "info", tuningFor(t))
	log := slog.New(l.Handler())
	log.Debug("below the app's level")
	log.Info("an info line", "component", CompUI, "subcomponent", "access")
	log.Log(context.Background(), LevelNotice, "a notice")
	log.Log(context.Background(), LevelCritical, "a critical")
	l.Append(Record{Level: slog.LevelDebug, Component: CompMounts, Subcomponent: "/mnt/x", Message: "a child's debug line"})
	closeTest(t, l)

	var got []string
	for _, r := range lines(fileRecords(t, l.Path())) {
		got = append(got, LevelWord(r.Level)+" "+r.Message)
	}
	want := []string{"info an info line", "notice a notice", "critical a critical", "debug a child's debug line"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("the file has %q, want %q", got, want)
	}
	text := stderr.String()
	for _, s := range []string{`level=INFO msg="an info line" component=ui subcomponent=access`, "level=NOTICE", "level=CRITICAL"} {
		if !strings.Contains(text, s) {
			t.Errorf("stderr lacks %q:\n%s", s, text)
		}
	}
	for _, s := range []string{"below the app's level", "a child's debug line", "Started", "Stopped"} {
		if strings.Contains(text, s) {
			t.Errorf("stderr has %q:\n%s", s, text)
		}
	}

	// A level changed while running applies to the next line.
	l2, _ := openTest(t, "warning", tuningFor(t))
	slog.New(l2.Handler()).Info("hidden")
	if err := l2.SetLevel("debug"); err != nil {
		t.Fatal(err)
	}
	slog.New(l2.Handler()).Debug("shown")
	closeTest(t, l2)
	if got := lines(fileRecords(t, l2.Path())); len(got) != 1 || got[0].Message != "shown" {
		t.Errorf("after SetLevel: %+v", got)
	}
}

func TestNoStderrUnlessAsked(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rcui.log")
	stderr := &syncBuffer{}
	tu := tuningFor(t)
	tu.stderr = stderr
	l, err := open(Options{Path: path}, tu)
	if err != nil {
		t.Fatal(err)
	}
	slog.New(l.Handler()).Error("to the file only")
	closeTest(t, l)
	if stderr.String() != "" {
		t.Errorf("stderr: %s", stderr.String())
	}
	if got := lines(fileRecords(t, path)); len(got) != 1 {
		t.Errorf("file: %+v", got)
	}
}

func TestStartAndStopMarksAndTheFileGoesOn(t *testing.T) {
	l, _ := openTest(t, "info", tuningFor(t))
	slog.New(l.Handler()).Info("between")
	closeTest(t, l)
	if err := l.Close(); err != nil {
		t.Errorf("a second Close: %v", err)
	}
	slog.New(l.Handler()).Info("after Close") // stderr only
	records := fileRecords(t, l.Path())
	if len(records) != 3 {
		t.Fatalf("%d records: %+v", len(records), records)
	}
	start, line, stop := records[0], records[1], records[2]
	if start.Mark != MarkStart || stop.Mark != MarkStop || line.Mark != "" || line.Message != "between" ||
		start.N != 1 || line.N != 2 || stop.N != 3 {
		t.Errorf("records %+v", records)
	}
	if info, err := os.Stat(l.Path()); err != nil || (info.Mode().Perm() != 0o600 && os.PathSeparator == '/') {
		t.Errorf("file mode: %v %v", info, err)
	}

	// The next run appends, numbering from 1 again after its own start mark.
	l2, err := Open(Options{Path: l.Path()})
	if err != nil {
		t.Fatal(err)
	}
	slog.New(l2.Handler()).Info("second run")
	closeTest(t, l2)
	records = fileRecords(t, l.Path())
	if len(records) != 6 || records[3].Mark != MarkStart || records[3].N != 1 || records[4].Message != "second run" {
		t.Errorf("after a second run: %+v", records)
	}
}

func TestTheFileStartsOverKeepingThePreviousOne(t *testing.T) {
	tu := tuningFor(t)
	tu.maxSize = 4 << 10
	tu.fold = foldRules{}
	l, _ := openTest(t, "info", tu)
	log := slog.New(l.Handler())
	for i := range 100 {
		log.Info(fmt.Sprintf("line %03d %s", i, strings.Repeat("x", 100)))
	}
	closeTest(t, l)
	current, previous := fileRecords(t, l.Path()), fileRecords(t, l.Path()+".1")
	for _, path := range []string{l.Path(), l.Path() + ".1"} {
		info, err := os.Stat(path)
		if err != nil || info.Size() > tu.maxSize {
			t.Errorf("%s: %v %v", path, info, err)
		}
	}
	if len(current) == 0 || len(previous) == 0 {
		t.Fatalf("current %d, previous %d records", len(current), len(previous))
	}
	// The two files are the newest lines, in order, with none missing between them.
	all := append(previous, current...)
	last := all[len(all)-1]
	if last.Mark != MarkStop {
		t.Fatalf("last record %+v", last)
	}
	for i := 1; i < len(all); i++ {
		if all[i].N != all[i-1].N+1 {
			t.Fatalf("record %d after %d", all[i].N, all[i-1].N)
		}
	}
	if len(all) >= 102 {
		t.Errorf("%d records kept: an older file was not dropped", len(all))
	}
}

func TestTail(t *testing.T) {
	tu := tuningFor(t)
	tu.ring = 10
	tu.fold = foldRules{}
	l, _ := openTest(t, "debug", tu)
	log := slog.New(l.Handler())
	for i := range 20 {
		log.Info(fmt.Sprint("line ", i))
	}
	testutil.Eventually(t, 5*time.Second, "the tail", func() bool {
		t := l.Tail(1)
		return len(t) == 1 && t[0].Message == "line 19"
	})

	msgs := func(rs []Record) []string {
		var out []string
		for _, r := range rs {
			out = append(out, r.Message)
		}
		return out
	}
	// The ring keeps the newest 10, oldest first.
	all := l.Tail(0)
	if len(all) != 10 || all[0].Message != "line 10" || all[9].Message != "line 19" {
		t.Errorf("tail %q", msgs(all))
	}
	for i := 1; i < len(all); i++ {
		if all[i].N != all[i-1].N+1 {
			t.Errorf("record %d after %d", all[i].N, all[i-1].N)
		}
	}
	if got := msgs(l.Tail(2)); !reflect.DeepEqual(got, []string{"line 18", "line 19"}) {
		t.Errorf("Tail(2) = %q", got)
	}
	if got := l.Tail(100); len(got) != 10 {
		t.Errorf("Tail(100) has %d records", len(got))
	}

	// Tail still works after Close, and the stop mark is the newest record.
	closeTest(t, l)
	if got := l.Tail(1); len(got) != 1 || got[0].Mark != MarkStop {
		t.Errorf("tail after Close: %+v", got)
	}
}

func TestRedact(t *testing.T) {
	const conn = ":s3,secret_access_key=XYZSECRET:bucket"
	const hidden = ":s3,secret_access_key=***:bucket"
	l, stderr := openTest(t, "info", tuningFor(t))
	slog.New(l.Handler()).Info("Opened "+conn,
		"object", conn+"/file", "source", conn, "nested", map[string]any{"k": conn},
		slog.Group("g", "v", "x "+conn), "list", []string{"a", conn},
		// The unquoted value runs to the comma, which is past the closing quote of its JSON string.
		"broken", []string{":sftp,pass=hunter22", "next"})
	child, ok := RcloneChild(CompMounts, "/mnt/x")(
		`{"level":"error","msg":"Failed to create file system for \"`+conn+`\"","source":"`+conn+`","remotes":["`+conn+`"]}`,
		Stderr, time.Now())
	if !ok {
		t.Fatal("the child's line did not parse")
	}
	l.Append(child)
	closeTest(t, l)

	raw, err := os.ReadFile(l.Path())
	if err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{"the file": string(raw), "stderr": stderr.String()} {
		if strings.Contains(text, "XYZSECRET") || strings.Contains(text, "hunter22") {
			t.Errorf("%s has a secret:\n%s", name, text)
		}
	}
	got := lines(fileRecords(t, l.Path()))
	if len(got) != 2 {
		t.Fatalf("%d lines", len(got))
	}
	app, fromChild := got[0], got[1]
	if app.Message != "Opened "+hidden || app.Object != hidden+"/file" || app.Source != hidden {
		t.Errorf("app line %+v", app)
	}
	want := `{"broken":"[\":sftp,pass=***,\"next\"]","g":{"v":"x ` + hidden + `"},"list":["a","` + hidden + `"],"nested":{"k":"` + hidden + `"}}`
	if have := jsonOf(t, app.Extra); have != want {
		t.Errorf("app line's extra\n %s\nwant %s", have, want)
	}
	if fromChild.Message != `Failed to create file system for "`+hidden+`"` || fromChild.Source != hidden ||
		jsonOf(t, fromChild.Extra) != `{"remotes":["`+hidden+`"]}` {
		t.Errorf("child's line %+v extra %s", fromChild, jsonOf(t, fromChild.Extra))
	}
}

func TestLoggerFollowsTheDefault(t *testing.T) {
	early := Logger(CompDB, SubOpen) // made before the log is the default, like a package variable
	l, _ := openTest(t, "info", tuningFor(t))
	old := slog.Default()
	slog.SetDefault(slog.New(l.Handler()))
	t.Cleanup(func() { slog.SetDefault(old) })

	early.Info("opened")
	Logger(CompApp, SubStartup).With("k", "v").WithGroup("g").Info("started", "a", 1)
	early.Debug("not enabled")
	closeTest(t, l)

	got := lines(fileRecords(t, l.Path()))
	if len(got) != 2 {
		t.Fatalf("%d lines", len(got))
	}
	if got[0].Component != CompDB || got[0].Subcomponent != SubOpen || got[0].Message != "opened" {
		t.Errorf("first %+v", got[0])
	}
	if got[1].Component != CompApp || got[1].Subcomponent != SubStartup || jsonOf(t, got[1].Extra) != `{"g":{"a":1},"k":"v"}` {
		t.Errorf("second %+v", got[1])
	}
}

func TestConcurrentLogging(t *testing.T) {
	l, _ := openTest(t, "info", tuningFor(t))
	log := slog.New(l.Handler())
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Go(func() {
			ctx := With(context.Background(), Transfer(fmt.Sprint(g)))
			for i := range 300 {
				log.InfoContext(ctx, fmt.Sprintf("line %d", i)) // each line is its own kind: none folded
			}
		})
	}
	wg.Wait()
	closeTest(t, l)
	if n := len(lines(fileRecords(t, l.Path()))); n != 8*300 {
		t.Errorf("%d lines, want %d", n, 8*300)
	}
}
