package telemetry

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/rclone/rclone-ui/core/settings"
)

// event is one event as PostHog receives it.
type event struct {
	Event      string         `json:"event"`
	DistinctID string         `json:"distinct_id"`
	Properties map[string]any `json:"properties"`
}

// receiver is a stand-in for PostHog that keeps what it receives.
type receiver struct {
	*httptest.Server
	mu     sync.Mutex
	events []event
	keys   []string
}

func newPostHog(t *testing.T) *receiver {
	p := &receiver{}
	p.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var batch struct {
			APIKey string  `json:"api_key"`
			Batch  []event `json:"batch"`
		}
		if err := json.Unmarshal(body, &batch); err != nil {
			t.Errorf("a request that isn't a batch: %v: %s", err, body)
		}
		p.mu.Lock()
		p.events = append(p.events, batch.Batch...)
		p.keys = append(p.keys, batch.APIKey)
		p.mu.Unlock()
		_, _ = w.Write([]byte(`{"status":1}`))
	}))
	t.Cleanup(p.Close)
	return p
}

func (p *receiver) got() []event {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]event(nil), p.events...)
}

// shared is the choice of a user who shares data.
var shared = settings.Telemetry{Enabled: true, ID: "0b0f2f0a-1111-4222-8333-444455556666"}

func service(p *receiver, o Options) *Service {
	o.Key, o.Host = "phc_test", p.URL
	return New(o)
}

func TestSendsNothingUntilAllowed(t *testing.T) {
	p := newPostHog(t)
	for name, c := range map[string]struct {
		o  Options
		st settings.Telemetry
	}{
		"turned off":          {Options{Key: "k"}, settings.Telemetry{}},
		"no id":               {Options{Key: "k"}, settings.Telemetry{Enabled: true}},
		"DO_NOT_TRACK":        {Options{Key: "k", DoNotTrack: true}, shared},
		"a build with no key": {Options{}, shared},
	} {
		c.o.Host = p.URL
		s := New(c.o)
		s.Apply(c.st)
		s.Capture("app_started", nil)
		s.Screen("Commander")
		s.Report(Crash{Kind: "panic", Message: "x"})
		s.Close()
		if got := p.got(); len(got) != 0 {
			t.Errorf("%s: sent %+v", name, got)
		}
	}
}

func TestCaptureSendsUnderTheUsersID(t *testing.T) {
	p := newPostHog(t)
	started := 0
	s := service(p, Options{Props: func() map[string]any { return map[string]any{"app_version": "4.0.0"} }, Started: func() { started++ }})
	s.Apply(shared)
	s.Apply(shared)
	s.Capture("transfer_ended", map[string]any{"operation": "copy", "files": 3})
	s.Screen("Commander")
	s.Close()

	got := p.got()
	if len(got) != 2 || started != 1 {
		t.Fatalf("%d events, started %d times: %+v", len(got), started, got)
	}
	e := got[0]
	if e.Event != "transfer_ended" || e.DistinctID != shared.ID {
		t.Fatalf("event %+v", e)
	}
	for key, want := range map[string]any{
		"operation": "copy", "files": float64(3), "app_version": "4.0.0",
		"$process_person_profile": false, "$geoip_disable": true,
	} {
		if e.Properties[key] != want {
			t.Errorf("%s = %v, want %v", key, e.Properties[key], want)
		}
	}
	if session, _ := e.Properties["$session_id"].(string); session == "" || session != got[1].Properties["$session_id"] {
		t.Errorf("the run's session: %v and %v", e.Properties["$session_id"], got[1].Properties["$session_id"])
	}
	if _, server := e.Properties["$is_server"]; server {
		t.Error("the event is marked as a server's")
	}
	if got[1].Event != "$screen" || got[1].Properties["$screen_name"] != "Commander" {
		t.Errorf("screen %+v", got[1])
	}
	if p.keys[0] != "phc_test" {
		t.Errorf("key %q", p.keys[0])
	}
}

// TestTurningOffDropsWhatWaits checks that an event still waiting to be sent when the user turns
// sharing off is never sent.
func TestTurningOffDropsWhatWaits(t *testing.T) {
	p := newPostHog(t)
	s := service(p, Options{})
	s.Apply(shared)
	s.Capture("app_started", nil)
	s.Apply(settings.Telemetry{})
	s.Capture("transfer_ended", nil)
	s.Close()
	if got := p.got(); len(got) != 0 {
		t.Fatalf("sent after turning off: %+v", got)
	}
}

func TestTrackTakesOnlyTheListedEvents(t *testing.T) {
	p := newPostHog(t)
	s := service(p, Options{})
	s.Apply(shared)
	for _, c := range []struct {
		name  string
		props map[string]any
		ok    bool
	}{
		{"disk_usage_opened", map[string]any{"local": true}, true},
		{"batch_rename_opened", map[string]any{"items": float64(12)}, true},
		{"compare_opened", nil, true},
		{"opened_my_folder", nil, false},
		{"compare_opened", map[string]any{"path": "/Users/me"}, false},
		{"disk_usage_opened", map[string]any{"local": "/Users/me"}, false},
		{"batch_rename_opened", map[string]any{"items": "many"}, false},
		{"batch_rename_opened", map[string]any{"items": 1.5}, false},
		{"batch_rename_opened", map[string]any{"items": true}, false},
	} {
		if err := s.Track(c.name, c.props); (err == nil) != c.ok {
			t.Errorf("%s %v: %v", c.name, c.props, err)
		}
	}
	s.Close()
	got := p.got()
	if len(got) != 3 || got[1].Properties["items"] != float64(12) || got[0].Properties["local"] != true {
		t.Fatalf("sent %+v", got)
	}
}

func TestScrub(t *testing.T) {
	names := []string{"work-drive", "s3"}
	for in, want := range map[string]string{
		"runtime error: index out of range [1] with length 1":                     "runtime error: index out of range [1] with length 1",
		`couldn't list files: Propfind "http://10.0.0.5:8080/": context canceled`: "couldn't list files: Propfind <quoted>: context canceled",
		// A path is taken out whole, spaces included, up to the end of its part of the message.
		"open /Users/me/Secret Plans/a.txt: permission denied":                    "open <path>: permission denied",
		`open C:\Users\me\My Documents\taxes.xlsx: access denied`:                 "open <path>: access denied",
		`\\nas\share\Bob's files is not reachable`:                                "<path>",
		"can't read work-drive:Clients/Acme Corp/2024 plan.pdf: object not found": "can't read <remote>: object not found",
		"failed to copy work-drive:Clients/Acme to s3:bucket/x":                   "failed to copy <remote>",
		"the remote work-drive is gone, and s3manager is fine":                    "the remote <remote> is gone, and s3manager is fine",
		"dial tcp 192.168.1.20:443: connection refused":                           "dial tcp <ip>:443: connection refused",
		"sign in as me@example.com at https://accounts.example.com/o?x=1 first":   "sign in as <email> at <url> first",
		"TypeError: undefined is not an object (evaluating 'a.b')":                "TypeError: undefined is not an object (evaluating 'a.b')",
		"read and/or write failed, n/a":                                           "read and/or write failed, n/a",
	} {
		if got := scrub(in, names); got != want {
			t.Errorf("%q\n got %q\nwant %q", in, got, want)
		}
	}
	if got := scrub(strings.Repeat("word ", 200), nil); len([]rune(got)) != messageMax+1 {
		t.Errorf("a long message is %d characters", len([]rune(got)))
	}
}

// boom panics three calls down, so that its stack has frames to read.
func boom(n int) {
	if n == 0 {
		var m map[string]int
		m["x"] = 1 //nolint // the panic this test reads
	}
	boom(n - 1)
}

func TestGoFramesOfARecoveredPanic(t *testing.T) {
	var (
		stack []byte
		value any
	)
	func() {
		defer func() {
			value = recover()
			stack = debug.Stack()
		}()
		boom(2)
	}()
	frames := goFrames(string(stack))
	if len(frames) < 4 {
		t.Fatalf("frames %+v from\n%s", frames, stack)
	}
	last := frames[len(frames)-1]
	if !strings.HasSuffix(last.Function, "telemetry.boom") || !strings.HasSuffix(last.File, "telemetry_test.go") || last.Line == 0 {
		t.Fatalf("the innermost frame is %+v, want boom in this file\n%s", last, stack)
	}
	for _, f := range frames {
		if strings.Contains(f.Function, "debug.Stack") || f.Function == "panic" || strings.Contains(f.Function, "(") && !strings.Contains(f.Function, "(*") {
			t.Errorf("frame %+v", f)
		}
	}
	if !inApp(last.Function) || inApp("runtime.mapassign_faststr") {
		t.Errorf("which frames are the app's own: %s", last.Function)
	}
	if fmt.Sprint(value) == "" {
		t.Fatal("no panic")
	}
}

func TestSourceFile(t *testing.T) {
	for in, want := range map[string]string{
		"github.com/rclone/rclone-ui/core/browse/usage.go": "github.com/rclone/rclone-ui/core/browse/usage.go",
		"runtime/panic.go":              "runtime/panic.go",
		"/Users/me/src/app/core/x.go":   "core/x.go",
		`C:\Users\me\src\app\core\x.go`: "core/x.go",
	} {
		if got := sourceFile(in); got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
}

func TestScriptFrames(t *testing.T) {
	webkit := "render@wails://localhost/assets/index-B2x9.js:120:33\n@wails://localhost/assets/index-B2x9.js:9:1\n[native code]"
	chromium := "TypeError: x is not a function\n    at render (http://wails.localhost/assets/index-B2x9.js?v=1:120:33)\n    at http://wails.localhost/assets/index-B2x9.js:9:1"
	for name, stack := range map[string]string{"webkit": webkit, "chromium": chromium} {
		frames := scriptFrames(stack)
		want := []Frame{
			{Function: "?", File: "assets/index-B2x9.js", Line: 9, Script: true},
			{Function: "render", File: "assets/index-B2x9.js", Line: 120, Script: true},
		}
		if len(frames) != 2 || frames[0] != want[0] || frames[1] != want[1] {
			t.Errorf("%s: %+v, want %+v", name, frames, want)
		}
	}
}

const crashText = `panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x2 addr=0x0 pc=0x104f8]

goroutine 42 [running]:
github.com/rclone/rclone-ui/core/browse.(*UsageTree).add(0x0, {0x14000, 0x1, 0x1})
	github.com/rclone/rclone-ui/core/browse/usage.go:201 +0x1c4
github.com/rclone/rclone-ui/core/browse.listUsage.func1({0x14000, 0x1, 0x1})
	github.com/rclone/rclone-ui/core/browse/usage.go:575 +0x88
created by github.com/rclone/rclone-ui/core/browse.walkUsage in goroutine 7
	github.com/rclone/rclone-ui/core/browse/usage.go:540 +0x2c

goroutine 1 [chan receive]:
main.main()
	github.com/rclone/rclone-ui/main.go:80 +0x10
`

func TestCrashOf(t *testing.T) {
	c, ok := crashOf(crashText)
	if !ok || c.Kind != "panic" || c.Message != "runtime error: invalid memory address or nil pointer dereference" || c.Handled {
		t.Fatalf("%+v %v", c, ok)
	}
	if len(c.Frames) != 3 || c.Frames[0].Function != "github.com/rclone/rclone-ui/core/browse.walkUsage" ||
		c.Frames[2].Function != "github.com/rclone/rclone-ui/core/browse.(*UsageTree).add" || c.Frames[2].Line != 201 {
		t.Fatalf("frames %+v: want the first goroutine only, outermost first", c.Frames)
	}
	if c, _ := crashOf("fatal error: concurrent map writes\n\ngoroutine 5 [running]:\n"); c.Kind != "fatal error" || c.Message != "concurrent map writes" {
		t.Fatalf("a fatal error: %+v", c)
	}
	if _, ok := crashOf("\n\n"); ok {
		t.Fatal("a crash in an empty file")
	}
}

// TestCrashLogReportsEachCrashOnce checks that a crash left by the last run is reported once, and
// that a crash from a run in which nothing was shared is never sent.
func TestCrashLogReportsEachCrashOnce(t *testing.T) {
	p := newPostHog(t)
	path := filepath.Join(t.TempDir(), "crash.log")
	if err := os.WriteFile(path, []byte(crashText), 0o600); err != nil {
		t.Fatal(err)
	}

	// A run in which nothing is shared reads past the crash.
	quiet := service(p, Options{})
	quiet.Apply(settings.Telemetry{})
	quiet.CrashLog(path)
	quiet.Close()
	s := service(p, Options{})
	s.Apply(shared)
	s.CrashLog(path)
	s.Close()
	if got := p.got(); len(got) != 0 {
		t.Fatalf("a crash from a run that shared nothing was sent: %+v", got)
	}

	// The next crash is appended, and reported once.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString("fatal error: concurrent map writes\n\ngoroutine 9 [running]:\nmain.work()\n\tgithub.com/rclone/rclone-ui/main.go:12 +0x1\n")
	_ = f.Close()
	for range 2 {
		s := service(p, Options{})
		s.Apply(shared)
		s.CrashLog(path)
		s.Close()
	}
	got := p.got()
	if len(got) != 1 || got[0].Event != "$exception" || got[0].Properties["source"] != "crash" {
		t.Fatalf("sent %+v", got)
	}
	list, _ := got[0].Properties["$exception_list"].([]any)
	item, _ := list[0].(map[string]any)
	if item["type"] != "fatal error" || item["value"] != "concurrent map writes" {
		t.Fatalf("the exception: %+v", item)
	}
	frames := item["stacktrace"].(map[string]any)["frames"].([]any)
	if frame := frames[0].(map[string]any); frame["function"] != "main.work" || frame["in_app"] != true || frame["lineno"] != float64(12) {
		t.Fatalf("frame %+v", frame)
	}
	if mechanism := item["mechanism"].(map[string]any); mechanism["handled"] != false {
		t.Fatalf("mechanism %+v", mechanism)
	}
}

// TestReportsEachErrorOnceAndScrubsIt checks that an error that repeats is reported once in a
// run, that its message is scrubbed, and that a run stops at its most reports.
func TestReportsEachErrorOnceAndScrubsIt(t *testing.T) {
	p := newPostHog(t)
	s := service(p, Options{Names: func() []string { return []string{"work-drive"} }})
	s.Apply(shared)
	for range 3 {
		s.Panic("core", "can't read work-drive:Clients/Acme", []byte("goroutine 1 [running]:\nmain.f()\n\tmain.go:3 +0x1\n"))
	}
	for i := range exceptionsMax + 5 {
		s.Report(Crash{Kind: "Error", Message: fmt.Sprintf("failure %d", i), Source: "page", Window: "Commander"})
	}
	s.Close()
	got := p.got()
	if len(got) != exceptionsMax {
		t.Fatalf("%d reports, want %d", len(got), exceptionsMax)
	}
	item := got[0].Properties["$exception_list"].([]any)[0].(map[string]any)
	if item["value"] != "can't read <remote>" || item["type"] != "panic" {
		t.Fatalf("the report: %+v", item)
	}
	if got[1].Properties["window"] != "Commander" || got[1].Properties["source"] != "page" {
		t.Fatalf("a page's report: %+v", got[1].Properties)
	}
}

// TestTapPanicsReportsWhatIsLoggedWithAStack checks that a recovered panic is reported by being
// logged the way every recover in the app logs it, and that other errors aren't.
func TestTapPanicsReportsWhatIsLoggedWithAStack(t *testing.T) {
	var got []string
	log := slog.New(TapPanics(slog.NewTextHandler(io.Discard, nil), func(source, value, stack string) {
		got = append(got, source+"|"+value+"|"+stack)
	}))
	core := log.With("component", "app", "subcomponent", "")
	core.Error("a goroutine panicked", "goroutine", "watchers", "panic", "boom", "stack", "goroutine 1 [running]:")
	core.Error("could not list", "error", "refused")
	core.Warn("slow", "stack", "not an error")
	log.With("component", "ui").Error("the launcher recovered", "stack", "goroutine 2 [running]:")
	want := []string{"app|boom|goroutine 1 [running]:", "ui|the launcher recovered|goroutine 2 [running]:"}
	if !slices.Equal(got, want) {
		t.Fatalf("reported %q, want %q", got, want)
	}
}
