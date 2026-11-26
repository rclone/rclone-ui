package logs

import (
	"container/list"
	"log/slog"
	"time"
)

const (
	foldWindow    = time.Minute
	foldBurst     = 20
	foldBurstLoud = 100
	foldQuiet     = 2 * time.Second
	maxKinds      = 1000
)

type foldRules struct {
	window, quiet    time.Duration
	burst, burstLoud int
	kinds            int
}

func folding() foldRules {
	return foldRules{window: foldWindow, quiet: foldQuiet, burst: foldBurst, burstLoud: foldBurstLoud, kinds: maxKinds}
}

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

type kind struct {
	key     kindKey
	start   time.Time
	seen    time.Time
	written int
	folded  int64
	first   time.Time
	last    time.Time
	latest  Record
	elem    *list.Element
}

type folder struct {
	rules   foldRules
	kinds   map[kindKey]*kind
	order   list.List
	pending int
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

func repeated(k *kind) Record {
	r := k.latest
	r.Mark, r.Time, r.Size, r.Count = MarkRepeated, k.last, nil, k.folded
	r.Extra = map[string]any{"first": wireTime(k.first), "last": wireTime(k.last)}
	return r
}
