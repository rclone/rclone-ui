package logs

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxFileSize   = 10 << 20
	ringSize      = 5000
	queueSize     = 65536
	failureNotice = 30 * time.Second
	closeWait     = 5 * time.Second
)

type Options struct {
	Path   string // usually <data>/logs/rcui.log; the folder is created if needed
	Stderr bool   // copy lines at Level and above to stderr as text
	Level  string // level of the app's lines: debug, info, notice, warning, error; "" is info
}

type tuning struct {
	stderr  io.Writer
	queue   int
	fold    foldRules
	maxSize int64
	ring    int
}

// Log is the app's log. Its handler never blocks. When the queue is full, lines are dropped and
// counted in a `dropped` mark. Every line that is appended is either written, folded into a
// `repeated` mark, or counted in a `dropped` mark.
type Log struct {
	path     string
	previous time.Time
	level    slog.LevelVar
	fold     foldRules
	maxSize  int64

	text slog.Handler

	queue   chan Record
	dropped atomic.Int64

	mu     sync.RWMutex
	closed bool

	tmu      sync.Mutex
	ring     []Record
	ringCap  int
	ringHead int

	quit      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
	closeErr  error
}

func Open(o Options) (*Log, error) {
	return open(o, tuning{stderr: os.Stderr, queue: queueSize, fold: folding(), maxSize: maxFileSize, ring: ringSize})
}

func open(o Options, t tuning) (*Log, error) {
	if o.Path == "" {
		return nil, errors.New("logs: no file path")
	}
	path, err := filepath.Abs(o.Path)
	if err != nil {
		return nil, err
	}
	l := &Log{
		path:    path,
		fold:    t.fold,
		maxSize: t.maxSize,
		queue:   make(chan Record, t.queue),
		ring:    make([]Record, 0, t.ring),
		ringCap: t.ring,
		quit:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	if o.Level != "" {
		if err := l.SetLevel(o.Level); err != nil {
			return nil, err
		}
	}
	if o.Stderr {
		l.text = textHandler(t.stderr)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("logs: %w", err)
	}
	if st, err := os.Stat(path); err == nil {
		l.previous = st.ModTime()
	}
	w := &writer{l: l, fold: newFolder(t.fold)}
	if err := w.openFile(); err != nil {
		return nil, fmt.Errorf("logs: %w", err)
	}
	l.push(l.mark(MarkStart, 0))
	go l.run(w)
	return l, nil
}

// Previous is when the previous process last wrote the log. It is zero on the first run.
func (l *Log) Previous() time.Time { return l.previous }

func (l *Log) Handler() slog.Handler { return &handler{l: l} }

// Path is the path of the log file. The previous file is Path() + ".1".
func (l *Log) Path() string { return l.path }

// SetLevel changes the level of the app's own lines. rclone's lines follow rclone's own level
// (see rclonelog).
func (l *Log) SetLevel(name string) error {
	lvl, err := ParseLevel(name)
	if err != nil {
		return err
	}
	l.level.Set(lvl)
	return nil
}

// Append adds one record, and also writes it to stderr when Options ask for that. Credentials
// are hidden first (see redact), so the file, the tail and stderr all get the redacted line.
// The children's lines also come in through Append. It never blocks: when the queue is full, the
// record is dropped and counted (see Log).
//
// The stderr copy is written here rather than by the writer, which writes the file later on its
// own goroutine. rclone's fs.Fatalf logs a line and then calls os.Exit(1), so a line logged right
// before such an exit only reaches stderr when it is written here.
func (l *Log) Append(r Record) {
	if r.Time.IsZero() {
		r.Time = time.Now()
	}
	if r.Component == "" {
		r.Component = CompApp
	}
	r.N, r.Mark, r.Count = 0, "", 0
	redact(&r)
	if l.text != nil && r.Level >= l.level.Level() {
		l.toStderr(r)
	}
	l.push(r)
}

func (l *Log) push(r Record) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.closed {
		return
	}
	if l.dropped.Load() > 0 {
		if n := l.dropped.Swap(0); n > 0 {
			select {
			case l.queue <- l.mark(MarkDropped, n):
			default:
				l.dropped.Add(n + 1)
				return
			}
		}
	}
	select {
	case l.queue <- r:
	default:
		l.dropped.Add(1)
	}
}

func (l *Log) mark(kind string, count int64) Record {
	r := Record{Mark: kind, Time: time.Now(), Level: LevelNotice, Component: CompApp}
	switch kind {
	case MarkStart:
		r.Subcomponent, r.Message = SubStartup, "Started"
	case MarkStop:
		r.Subcomponent, r.Message = SubShutdown, "Stopped"
	case MarkDropped:
		r.Level = slog.LevelWarn
		r.Message = fmt.Sprintf("the core dropped %d lines", count)
		r.Count = count
	}
	return r
}

// Close writes every queued line, the counts of all folded lines and then the `stop` mark, and
// closes the file. Lines appended after Close only go to stderr, but Tail still works.
func (l *Log) Close() error {
	l.closeOnce.Do(func() {
		l.mu.Lock()
		l.closed = true
		l.mu.Unlock()
		close(l.quit)
	})
	select {
	case <-l.done:
		return l.closeErr
	case <-time.After(closeWait):
		return errors.New("logs: the writer did not finish")
	}
}

func (l *Log) run(w *writer) {
	defer close(l.done)
	w.sweep = time.NewTimer(time.Hour)
	w.sweep.Stop()
	for {
		select {
		case r := <-l.queue:
			w.add(r)
			if len(l.queue) == 0 {
				if n := l.dropped.Swap(0); n > 0 {
					w.emit(l.mark(MarkDropped, n))
				}
				w.flush()
			}
		case <-w.sweep.C:
			w.sweeping = false
			for _, r := range w.fold.sweep(time.Now()) {
				w.emit(r)
			}
			w.armSweep()
			w.flush()
		case <-l.quit:
			for len(l.queue) > 0 {
				w.add(<-l.queue)
			}
			for _, r := range w.fold.all() {
				w.emit(r)
			}
			if n := l.dropped.Swap(0); n > 0 {
				w.emit(l.mark(MarkDropped, n))
			}
			w.emit(l.mark(MarkStop, 0))
			l.closeErr = w.closeFile()
			return
		}
	}
}

type writer struct {
	l    *Log
	n    int64
	fold *folder

	sweep    *time.Timer
	sweeping bool

	f    *os.File
	buf  *bufio.Writer
	size int64

	lost       int64
	failNotice time.Time
	retryAt    time.Time
}

func (w *writer) add(r Record) {
	write, due := w.fold.line(r, time.Now())
	for _, d := range due {
		w.emit(d)
	}
	if write {
		w.emit(r)
	}
	w.armSweep()
}

func (w *writer) armSweep() {
	if w.fold.pending > 0 && !w.sweeping {
		w.sweep.Reset(w.fold.rules.quiet / 2)
		w.sweeping = true
	}
}

func (w *writer) emit(r Record) {
	w.n++
	r.N = w.n
	line, err := json.Marshal(r)
	if err != nil {
		line = fmt.Appendf(nil, `{"n":%d,"level":"error","component":"app","msg":%q}`, r.N, "unencodable line: "+err.Error())
	}
	w.write(append(line, '\n'))
	w.l.tail(r)
}

func (w *writer) write(line []byte) {
	if w.f == nil {
		if time.Now().Before(w.retryAt) || w.openFile() != nil {
			w.lost++
			return
		}
	}
	if w.size > 0 && w.size+int64(len(line)) > w.l.maxSize {
		if err := w.rotate(); err != nil {
			w.failed(err)
			w.lost++
			return
		}
	}
	n, err := w.buf.Write(line)
	w.size += int64(n)
	if err != nil {
		w.failed(err)
	}
}

func (w *writer) flush() {
	if w.buf == nil {
		return
	}
	if err := w.buf.Flush(); err != nil {
		w.failed(err)
	}
}

func (w *writer) openFile() error {
	f, err := os.OpenFile(w.l.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err == nil {
		var info os.FileInfo
		if info, err = f.Stat(); err == nil {
			w.f, w.size = f, info.Size()
			w.buf = bufio.NewWriterSize(f, 64<<10)
			if w.lost > 0 {
				notice(fmt.Sprintf("rcui: the log file is written again (%d lines were not)", w.lost))
				w.lost = 0
			}
			return nil
		}
		_ = f.Close()
	}
	w.failed(err)
	return err
}

// rotate starts the file over, keeping the previous one as <path>.1. Where the rename is
// refused (Windows, while another program has the file open), the file is truncated instead.
func (w *writer) rotate() error {
	if err := w.closeFile(); err != nil {
		return err
	}
	if err := os.Rename(w.l.path, w.l.path+".1"); err != nil {
		f, err := os.OpenFile(w.l.path, os.O_WRONLY|os.O_TRUNC|os.O_CREATE, 0o600)
		if err != nil {
			return err
		}
		_ = f.Close()
	}
	return w.openFile()
}

func (w *writer) closeFile() error {
	if w.f == nil {
		return nil
	}
	err := w.buf.Flush()
	if cerr := w.f.Close(); err == nil {
		err = cerr
	}
	w.f, w.buf, w.size = nil, nil, 0
	return err
}

func (w *writer) failed(err error) {
	if w.f != nil {
		_ = w.f.Close()
		w.f, w.buf, w.size = nil, nil, 0
	}
	now := time.Now()
	w.retryAt = now.Add(failureNotice)
	if now.Sub(w.failNotice) >= failureNotice {
		notice(fmt.Sprintf("rcui: the log file %s cannot be written (%d lines lost so far): %v", w.l.path, w.lost, err))
		w.failNotice = now
	}
}

func notice(msg string) { _, _ = fmt.Fprintln(os.Stderr, msg) }

func (l *Log) tail(r Record) {
	l.tmu.Lock()
	defer l.tmu.Unlock()
	if len(l.ring) < l.ringCap {
		l.ring = append(l.ring, r)
	} else if l.ringCap > 0 {
		l.ring[l.ringHead] = r
		l.ringHead = (l.ringHead + 1) % l.ringCap
	}
}

// Tail returns the newest limit records from memory, oldest first. A limit of 0 or less means
// 500. Memory holds the last 5000 records of this run, and older ones are only in the file.
func (l *Log) Tail(limit int) []Record {
	if limit <= 0 {
		limit = 500
	}
	l.tmu.Lock()
	defer l.tmu.Unlock()
	n := min(limit, len(l.ring))
	out := make([]Record, 0, n)
	for i := len(l.ring) - n; i < len(l.ring); i++ {
		out = append(out, l.ring[(l.ringHead+i)%len(l.ring)])
	}
	return out
}

func textHandler(w io.Writer) slog.Handler {
	return slog.NewTextHandler(w, &slog.HandlerOptions{
		Level: slog.Level(math.MinInt32),
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) == 0 && a.Key == slog.LevelKey {
				if l, ok := a.Value.Any().(slog.Level); ok {
					a.Value = slog.StringValue(strings.ToUpper(LevelWord(l)))
				}
			}
			return a
		},
	})
}

func (l *Log) toStderr(r Record) {
	rec := slog.NewRecord(r.Time, r.Level, r.Message, 0)
	rec.AddAttrs(slog.String("component", r.Component))
	str := func(key, v string) {
		if v != "" {
			rec.AddAttrs(slog.String(key, v))
		}
	}
	str("subcomponent", r.Subcomponent)
	str("object", r.Object)
	str("objectType", r.ObjectType)
	str("source", r.Source)
	if r.Size != nil {
		rec.AddAttrs(slog.Int64("size", *r.Size))
	}
	str("stats_group", r.StatsGroup)
	str("transfer", r.Transfer)
	if r.Job != 0 {
		rec.AddAttrs(slog.Int64("job", r.Job))
	}
	str("operation", r.Operation)
	for _, k := range slices.Sorted(maps.Keys(r.Extra)) {
		v := r.Extra[k]
		if raw, ok := v.(json.RawMessage); ok {
			v = string(raw)
		}
		rec.AddAttrs(slog.Any(k, v))
	}
	_ = l.text.Handle(context.Background(), rec)
}
