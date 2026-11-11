// Package rclonelog handles rclone's own log lines. rclone logs through the handler set with
// fs.SetLogger. This package's handler gives each line its component and backend, and passes it
// to the app's log, which hides any credentials in the line (see logs.Redact).
//
// rclone v1.75.1 logs every line with context.Background() (fs/log.go:143-145, logSlog), so its
// lines carry no stats group, job or transfer. The core's own lines about a transfer carry those
// instead (see logs.With).
package rclonelog

import (
	"context"
	"fmt"
	"log/slog"
	"runtime"
	"strings"
	"sync"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/logs"
)

// Install makes rclone log through l. Call it after package initialisation, because rclone's
// fs/log installs its own handler during initialisation. Never call fs/log's InitLogging, which
// would make rclone's handler the slog default.
func Install(l *logs.Log) {
	fs.SetLogger(newHandler(l))
}

type handler struct {
	next     slog.Handler    // the app log's handler
	backends map[string]bool // every backend's name, prefix and file name, as fs.Find matches them
	pre      []slog.Attr     // from WithAttrs, already nested in the groups open at that time
	groups   []string        // from WithGroup
}

func newHandler(l *logs.Log) *handler {
	h := &handler{backends: map[string]bool{}}
	if l != nil {
		h.next = l.Handler()
	}
	for _, ri := range fs.Registry {
		h.backends[ri.Name] = true
		h.backends[ri.FileName()] = true
		if ri.Prefix != "" {
			h.backends[ri.Prefix] = true
		}
	}
	return h
}

// level returns rclone's global log level. rclone checks it before it logs (fs/log.go). rclone's
// own handler has a separate level, which options/set changes.
func level() slog.Level {
	return fs.LogLevelToSlog(fs.GetConfig(context.Background()).LogLevel)
}

func (h *handler) Enabled(_ context.Context, l slog.Level) bool { return l >= level() }

// watchers are the functions that Watch added, by a key of their own.
var watchers struct {
	sync.Mutex
	next int
	fns  map[int]func(slog.Level, string)
}

// Watch calls fn with the level and message of each line that rclone logs, until the returned
// stop is called. Lines below rclone's log level are not logged, so fn doesn't see them. rclone's
// lines carry no context, so fn sees every line logged meanwhile, by any work. fn runs on the
// logging goroutine and must be quick.
func Watch(fn func(level slog.Level, msg string)) (stop func()) {
	watchers.Lock()
	defer watchers.Unlock()
	if watchers.fns == nil {
		watchers.fns = map[int]func(slog.Level, string){}
	}
	key := watchers.next
	watchers.next++
	watchers.fns[key] = fn
	return func() {
		watchers.Lock()
		defer watchers.Unlock()
		delete(watchers.fns, key)
	}
}

// tell passes a line to the functions that Watch added.
func tell(level slog.Level, msg string) {
	watchers.Lock()
	fns := make([]func(slog.Level, string), 0, len(watchers.fns))
	for _, fn := range watchers.fns {
		fns = append(fns, fn)
	}
	watchers.Unlock()
	for _, fn := range fns {
		fn(level, msg)
	}
}

func (h *handler) Handle(ctx context.Context, r slog.Record) error {
	tell(r.Level, r.Message)
	if h.next == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var attrs []slog.Attr
	objectType := ""
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == "objectType" {
			objectType = a.Value.String()
		}
		attrs = append(attrs, a)
		return true
	})
	out := slog.NewRecord(r.Time, r.Level, r.Message, 0)
	out.AddAttrs(
		slog.String("component", logs.CompRclone),
		slog.String("subcomponent", h.subcomponent(objectType)),
	)
	if src := source(); src != "" {
		out.AddAttrs(slog.String("source", src))
	}
	out.AddAttrs(h.pre...)
	out.AddAttrs(nest(h.groups, attrs)...)
	return h.next.Handle(ctx, out)
}

func (h *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	next := *h
	next.pre = append(h.pre[:len(h.pre):len(h.pre)], nest(h.groups, attrs)...)
	return &next
}

func (h *handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	next := *h
	next.groups = append(h.groups[:len(h.groups):len(h.groups)], name)
	return &next
}

// nest puts attrs inside groups, outermost first.
func nest(groups []string, attrs []slog.Attr) []slog.Attr {
	for i := len(groups) - 1; i >= 0 && len(attrs) > 0; i-- {
		attrs = []slog.Attr{{Key: groups[i], Value: slog.GroupValue(attrs...)}}
	}
	return attrs
}

// subcomponent returns the backend of the logged object. That is the package of its type (from
// %T, such as *s3.Object) when it is a registered backend, and core otherwise.
func (h *handler) subcomponent(objectType string) string {
	pkg, _, ok := strings.Cut(strings.TrimLeft(objectType, "*[]"), ".")
	switch {
	case !ok:
		return logs.SubCore
	case h.backends[pkg]:
		return pkg
	}
	return logs.SubCore
}

// source returns the file:line in rclone that logged the line. Like rclone's own handler, it
// keeps only the last two path elements.
func source() string {
	var pcs [32]uintptr
	n := runtime.Callers(3, pcs[:]) // runtime.Callers, source, Handle
	frames := runtime.CallersFrames(pcs[:n])
	for {
		f, more := frames.Next()
		if !logFrame(f) {
			return short(f.File, f.Line)
		}
		if !more {
			return ""
		}
	}
}

// logFrame reports whether a frame is part of the logging code: slog, rclone's fs/log.go, or
// the fs/log package.
func logFrame(f runtime.Frame) bool {
	return strings.HasPrefix(f.Function, "log/slog.") ||
		strings.HasSuffix(f.File, "/fs/log.go") ||
		strings.HasPrefix(f.Function, "github.com/rclone/rclone/fs/log.")
}

func short(file string, line int) string {
	if file == "" {
		return ""
	}
	n := 0
	for i := len(file) - 1; i > 0; i-- {
		if file[i] == '/' {
			n++
			if n == 2 {
				file = file[i+1:]
				break
			}
		}
	}
	return fmt.Sprintf("%s:%d", file, line)
}
