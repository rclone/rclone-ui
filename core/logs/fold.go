package logs

import (
	"container/list"
	"log/slog"
	"time"
)

// Folding. rclone can repeat a line for every object it finds. For example, measuring the size
// of a home folder once wrote "Can't follow symlink without -L/--copy-links" 370 419 times in one
// run, which came to 110 MB. Without folding, a 10 MB file that starts over would hold a few
// minutes of one flood and nothing from before it.
//
// So within a time window, the writer writes the first lines of each kind and only counts the
// rest. It then writes one `repeated` mark with the count and the last object.
//
// A line's kind is everything except its object, size, time and extra (see kindKey). The
// windows use the writer's clock rather than the lines' own times, because a child's clock may
// be off.
const (
	// foldWindow is how long a kind's allowance lasts, counted from its first line. With one
	// minute, a flood adds only a few lines a minute however long it lasts, and a kind that
	// comes back later has its lines shown again.
	foldWindow = time.Minute
	// foldBurst is the number of lines of a kind written per window, for levels from debug to
	// warning. That is enough to show the pattern and a range of its objects. Only a kind that
	// is logged more often than every 3 s gets folded. A transfer also keeps its own record of
	// each file's outcome.
	foldBurst = 20
	// foldBurstLoud is the allowance for error and critical lines. They are the lines people
	// read the log for, and a transfer's failures differ from object to object. Even so, 100 a
	// minute still limits a systematic failure (such as permission denied across a whole tree)
	// to 6 000 lines an hour.
	foldBurstLoud = 100
	// foldQuiet is how long a kind must have no new line before its count is written. This
	// puts the mark next to the burst it follows rather than up to a minute later. The kind's
	// allowance stays used up until its window ends. The writer checks every foldQuiet/2, so a
	// kind that is logged every 3 s or less often is written in full. A count of one is written
	// as the line itself.
	foldQuiet = 2 * time.Second
	// maxKinds is the most kinds tracked at once. When there are too many, the least recently
	// seen kind is removed and its count is written. Each kind holds the strings of two of its
	// lines.
	maxKinds = 1000
)

// foldRules are the folding parameters. The app uses the constants above, and the tests use
// smaller values. The zero value folds nothing.
type foldRules struct {
	window, quiet    time.Duration
	burst, burstLoud int
	kinds            int
}

func folding() foldRules {
	return foldRules{window: foldWindow, quiet: foldQuiet, burst: foldBurst, burstLoud: foldBurstLoud, kinds: maxKinds}
}

// kindKey decides which lines are alike. It holds every column except the object, the size,
// the time and extra. The attribution is part of it, so one transfer's burst never hides another
// transfer's lines. It also means a `repeated` mark belongs to the same transfer as its lines,
// so anyone who picks that transfer's lines out of the file finds the mark with them.
type kindKey struct {
	level                                    slog.Level
	component, subcomponent, message, source string
	objectType                               string
	statsGroup, transfer, operation          string
	job                                      int64
}

func keyOf(r *Record) kindKey {
	return kindKey{
		level: r.Level, component: r.Component, subcomponent: r.Subcomponent, message: r.Message,
		source: r.Source, objectType: r.ObjectType, statsGroup: r.StatsGroup, transfer: r.Transfer,
		operation: r.Operation, job: r.Job,
	}
}

// kind is the current window of one kind.
type kind struct {
	key     kindKey
	start   time.Time // when the window started, on the writer's clock
	seen    time.Time // when the newest line arrived, on the writer's clock
	written int
	folded  int64     // lines counted but not written since the last mark
	first   time.Time // first and last of the folded lines' own times
	last    time.Time
	latest  Record // the newest folded line
	elem    *list.Element
}

// folder is the writer's folding state. Only the writer goroutine uses it.
type folder struct {
	rules   foldRules
	kinds   map[kindKey]*kind
	order   list.List // *kind values, the most recently seen first
	pending int       // number of kinds with folded lines that have no mark yet
	out     []Record
}

func newFolder(rules foldRules) *folder {
	return &folder{rules: rules, kinds: map[kindKey]*kind{}}
}

func (f *folder) burst(level slog.Level) int {
	if level >= slog.LevelError {
		return f.rules.burstLoud
	}
	return f.rules.burst
}

// line handles a record from the queue. It reports whether to write the record, and returns the
// records to write before it: the mark of its kind's window if that window ended, and the mark of
// a kind removed to make room. due is valid until the next call.
func (f *folder) line(r Record, now time.Time) (write bool, due []Record) {
	if r.Mark != "" || f.rules.window <= 0 {
		return true, nil
	}
	f.out = f.out[:0]
	key := keyOf(&r)
	k := f.kinds[key]
	if k != nil && now.Sub(k.start) >= f.rules.window {
		f.end(k)
		k = nil
	}
	if k == nil {
		if len(f.kinds) >= f.rules.kinds {
			f.end(f.order.Back().Value.(*kind))
		}
		k = &kind{key: key, start: now}
		k.elem = f.order.PushFront(k)
		f.kinds[key] = k
	} else {
		f.order.MoveToFront(k.elem)
	}
	k.seen = now
	if k.written < f.burst(r.Level) {
		k.written++
		return true, f.out
	}
	if k.folded == 0 {
		k.first, k.last = r.Time, r.Time
		f.pending++
	}
	k.folded++
	if r.Time.Before(k.first) {
		k.first = r.Time
	}
	if r.Time.After(k.last) {
		k.last = r.Time
	}
	k.latest = r
	return false, f.out
}

// sweep returns the counts that are due at now. These are the counts of kinds that have been
// quiet for f.rules.quiet, and of windows that ended, whose kinds start over. The least recently
// seen come first. The result is valid until the next call.
func (f *folder) sweep(now time.Time) []Record {
	f.out = f.out[:0]
	for e := f.order.Back(); e != nil; {
		k, prev := e.Value.(*kind), e.Prev()
		switch {
		case now.Sub(k.start) >= f.rules.window:
			f.end(k)
		case k.folded > 0 && now.Sub(k.seen) >= f.rules.quiet:
			f.mark(k)
		}
		e = prev
	}
	return f.out
}

// all ends every window, at Close, and returns their counts with the least recently seen first.
// The result is valid until the next call.
func (f *folder) all() []Record {
	f.out = f.out[:0]
	for e := f.order.Back(); e != nil; e = e.Prev() {
		f.mark(e.Value.(*kind))
	}
	clear(f.kinds)
	f.order.Init()
	return f.out
}

func (f *folder) end(k *kind) {
	f.mark(k)
	f.order.Remove(k.elem)
	delete(f.kinds, k.key)
}

// mark writes what k counted. A single line is written as it came, and more than one becomes a
// `repeated` mark.
func (f *folder) mark(k *kind) {
	switch {
	case k.folded == 0:
		return
	case k.folded == 1:
		f.out = append(f.out, k.latest)
	default:
		f.out = append(f.out, repeated(k))
	}
	k.folded, k.latest = 0, Record{}
	f.pending--
}

// repeated builds the mark for k's folded lines, which reads as "…and N more like this, last:
// <object>". It has the kind's columns and message, the object and time of the newest line, the
// count, and the times of the first and last lines in extra. Anything a folded line had only in
// its object or extra is lost, so a line whose details matter every time should put them in its
// message.
func repeated(k *kind) Record {
	r := k.latest
	r.Mark, r.Time, r.Size, r.Count = MarkRepeated, k.last, nil, k.folded
	r.Extra = map[string]any{"first": wireTime(k.first), "last": wireTime(k.last)}
	return r
}
