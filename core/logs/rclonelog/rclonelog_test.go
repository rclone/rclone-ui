package rclonelog

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	_ "github.com/rclone/rclone/backend/crypt"
	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/memory"
	_ "github.com/rclone/rclone/backend/sftp"
	_ "github.com/rclone/rclone/backend/union"
	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/logs"
)

// capture installs the handler on a new log with rclone's level set to lvl, runs fn and
// returns the lines it logged.
func capture(t *testing.T, lvl fs.LogLevel, fn func(l *logs.Log)) []logs.Record {
	t.Helper()
	l, err := logs.Open(logs.Options{Path: filepath.Join(t.TempDir(), "rcui.log"), Level: "error"})
	if err != nil {
		t.Fatal(err)
	}
	ci := fs.GetConfig(context.Background())
	old := ci.LogLevel
	ci.LogLevel = lvl
	defer func() { ci.LogLevel = old }()
	Install(l)
	fn(l)
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	var out []logs.Record
	for _, r := range l.Tail(1000) {
		if r.Mark == "" {
			out = append(out, r)
		}
	}
	return out
}

// A line keeps what rclone logged with it (its object, its values and where it was logged) and
// gets its component. rclone v1.75.1 logs without its caller's context, so a line has no stats
// group or job.
func TestLineFromRclone(t *testing.T) {
	var logLine int
	rows := capture(t, fs.LogLevelInfo, func(l *logs.Log) {
		_, _, logLine, _ = runtime.Caller(0)
		fs.Infof("file.txt", "Copied (new)%v", fs.LogValueHide("size", int64(42)))
		slog.New(newHandler(l)).Info("derived", "object", "file.txt", "objectType", "string", "extra_key", "v")
	})
	if len(rows) != 2 {
		t.Fatalf("got %d lines, want 2: %+v", len(rows), rows)
	}
	r := rows[0]
	if r.Component != logs.CompRclone || r.Subcomponent != logs.SubCore || r.Level != slog.LevelInfo {
		t.Errorf("component/subcomponent/level = %s/%s/%v", r.Component, r.Subcomponent, r.Level)
	}
	if r.Object != "file.txt" || r.ObjectType != "string" || r.Size == nil || *r.Size != 42 ||
		!strings.HasPrefix(r.Message, "Copied (new)") {
		t.Errorf("object %q type %q size %v message %q", r.Object, r.ObjectType, r.Size, r.Message)
	}
	if want := fmt.Sprintf("rclonelog/rclonelog_test.go:%d", logLine+1); r.Source != want {
		t.Errorf("source %q, want %q", r.Source, want)
	}
	// This fails once rclone passes its callers' contexts. Lines can then be linked to their
	// transfer, and the package comment needs updating.
	if r.StatsGroup != "" || r.Job != 0 || r.Operation != "" {
		t.Errorf("rclone's own line is attributed: %+v", r)
	}
	if u := rows[1]; u.Object != "file.txt" || u.Extra["extra_key"] != "v" {
		t.Errorf("a derived logger's line: %+v", u)
	}
}

func TestSubcomponentFromObjectType(t *testing.T) {
	ctx := context.Background()
	mem, err := fs.NewFs(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	loc, err := fs.NewFs(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rows := capture(t, fs.LogLevelInfo, func(*logs.Log) {
		fs.Infof(mem, "from memory")
		fs.Infof(loc, "from local")
		fs.Infof("a string", "from core")
		fs.Infof(nil, "from nothing")
	})
	want := map[string]string{"from memory": "memory", "from local": "local", "from core": "core", "from nothing": "core"}
	if len(rows) != len(want) {
		t.Fatalf("got %d lines", len(rows))
	}
	for _, r := range rows {
		if want[r.Message] != r.Subcomponent {
			t.Errorf("%q: subcomponent %q, want %q", r.Message, r.Subcomponent, want[r.Message])
		}
	}

	h := newHandler(nil)
	for typ, sub := range map[string]string{
		"*crypt.Object": "crypt", "*union.Fs": "union", "*local.Object": "local", "*memory.Object": "memory",
		"*operations.thing": "core", "string": "core", "": "core",
		"map[string]string": "core", "[]*crypt.Object": "crypt", "*s3.Object": "core", // s3 is not linked here
	} {
		if got := h.subcomponent(typ); got != sub {
			t.Errorf("subcomponent(%q) = %q, want %q", typ, got, sub)
		}
	}
}

func TestLevelFromRclone(t *testing.T) {
	rows := capture(t, fs.LogLevelNotice, func(*logs.Log) {
		fs.Debugf(nil, "debug")
		fs.Infof(nil, "info")
		fs.Logf(nil, "notice")
		fs.Errorf(nil, "error")
	})
	var got []string
	for _, r := range rows {
		got = append(got, logs.LevelWord(r.Level)+":"+r.Message)
	}
	if strings.Join(got, ",") != "notice:notice,error:error" {
		t.Errorf("lines %v", got)
	}
	h := newHandler(nil)
	ci := fs.GetConfig(context.Background())
	old := ci.LogLevel
	defer func() { ci.LogLevel = old }()
	ci.LogLevel = fs.LogLevelNotice
	if h.Enabled(context.Background(), slog.LevelInfo) || !h.Enabled(context.Background(), logs.LevelNotice) {
		t.Error("Enabled does not follow rclone's level")
	}
}

func TestAttrsAndGroupsOfDerivedLoggers(t *testing.T) {
	rows := capture(t, fs.LogLevelInfo, func(l *logs.Log) {
		slog.New(newHandler(l)).With("a", 1).WithGroup("g").Info("derived", "b", 2)
	})
	if len(rows) != 1 {
		t.Fatalf("got %d lines", len(rows))
	}
	b, err := json.Marshal(rows[0].Extra)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"a":1,"g":{"b":2}}` || rows[0].Component != logs.CompRclone {
		t.Errorf("extra %s component %s", b, rows[0].Component)
	}
}

func TestCredentialsAreHidden(t *testing.T) {
	// sftp's host and user are marked Sensitive too, so `rclone config redacted` hides them.
	for in, want := range map[string]string{
		`:sftp,host=example.com,pass=hunter22,port=22:dir`:                     `:sftp,host=***,pass=***,port=22:dir`,
		`:s3,access_key_id=AKIA,secret_access_key="a,b""c":bucket/x`:           `:s3,access_key_id=***,secret_access_key=***:bucket/x`,
		`remote,client_secret='x''y',chunk_size=5M:path`:                       `remote,client_secret=***,chunk_size=5M:path`,
		`:sftp,key_file_pass=obscured,port=22:`:                                `:sftp,key_file_pass=***,port=22:`,
		`Failed to create file system for ":http,url='https://u:pw@h/p'": 401`: `Failed to create file system for ":http,url='https://u:***@h/p'": 401`,
		`GET https://user:secret@example.com/dav/file`:                         `GET https://user:***@example.com/dav/file`,
		`:http,url='https://h/p',headers='Authorization,Bearer XYZ':dir`:       `:http,url='https://h/p',headers=***:dir`,
		`:webdav,url='https://h',headers="Cookie,session=abc":dir`:             `:webdav,url='https://h',headers=***:dir`,
		`Copied (new) a=b, c=d`:                                                `Copied (new) a=b, c=d`,
		`nothing to hide`:                                                      `nothing to hide`,
	} {
		if got := logs.Redact(in); got != want {
			t.Errorf("Redact(%q)\n = %q\nwant %q", in, got, want)
		}
	}

	rows := capture(t, fs.LogLevelInfo, func(*logs.Log) {
		fs.Infof(":sftp,host=h,pass=hunter22:dir", "Opened :sftp,host=h,pass=hunter22:dir")
	})
	if len(rows) != 1 || strings.Contains(rows[0].Message+rows[0].Object, "hunter22") {
		t.Errorf("a password reached the log: %+v", rows)
	}
}

// Watch sees each line that rclone logs until it is stopped, even without the app's log.
func TestWatch(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	stop := Watch(func(level slog.Level, msg string) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, level.String()+" "+msg)
	})
	Install(nil)
	fs.Errorf("Safety abort", "too many deletes (>%d%%, %d of %d)", 50, 3, 4)
	stop()
	fs.Errorf(nil, "after the stop")
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 || seen[0] != "ERROR too many deletes (>50%, 3 of 4)" {
		t.Errorf("seen %q", seen)
	}
}
