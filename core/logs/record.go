package logs

import (
	"context"
	"encoding"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"time"
)

// Record is one line of the log, as stored in the file and the tail. The handler makes one from
// each slog record, and a child's line reader makes them from what the child printed.
type Record struct {
	// N numbers this process's records from 1, in the order they were written. The start mark
	// is 1. The file continues across runs, and each run begins with its start mark.
	N            int64
	Time         time.Time
	Level        slog.Level
	Component    string
	Subcomponent string
	Message      string
	Source       string // file:line in rclone's Go code
	Object       string
	ObjectType   string
	Size         *int64
	StatsGroup   string
	Transfer     string
	Job          int64
	Operation    string
	// Mark is set on the log's own lines: start, stop, dropped and repeated. On a dropped mark,
	// Count is the number of lines dropped because the queue was full. On a repeated mark, Count
	// is the number of lines of one kind folded into this one (fold.go).
	Mark  string
	Count int64
	// Extra holds every other attribute. Its values are made safe for JSON when the record is
	// made.
	Extra map[string]any
}

// The marks. They are numbered in the same sequence as the other lines.
const (
	MarkStart    = "start"
	MarkStop     = "stop"
	MarkDropped  = "dropped"
	MarkRepeated = "repeated"
)

// wire is a record as written in one JSON line of the file.
type wire struct {
	N            int64          `json:"n,omitempty"`
	Time         string         `json:"time"`
	Level        string         `json:"level"`
	Component    string         `json:"component"`
	Subcomponent string         `json:"subcomponent,omitempty"`
	Message      string         `json:"msg"`
	Source       string         `json:"source,omitempty"`
	Object       string         `json:"object,omitempty"`
	ObjectType   string         `json:"objectType,omitempty"`
	Size         *int64         `json:"size,omitempty"`
	StatsGroup   string         `json:"statsGroup,omitempty"`
	Transfer     string         `json:"transfer,omitempty"`
	Job          int64          `json:"job,omitempty"`
	Operation    string         `json:"operation,omitempty"`
	Mark         string         `json:"mark,omitempty"`
	Count        int64          `json:"count,omitempty"`
	Extra        map[string]any `json:"extra,omitempty"`
}

// MarshalJSON encodes the record as the file stores it. The level is written as its word, and
// the time in RFC 3339 UTC to the millisecond.
func (r Record) MarshalJSON() ([]byte, error) {
	w := wire{
		N: r.N, Time: wireTime(r.Time), Level: LevelWord(r.Level), Component: r.Component,
		Subcomponent: r.Subcomponent, Message: r.Message, Source: r.Source, Object: r.Object,
		ObjectType: r.ObjectType, Size: r.Size, StatsGroup: r.StatsGroup, Transfer: r.Transfer,
		Job: r.Job, Operation: r.Operation, Mark: r.Mark, Count: r.Count, Extra: r.Extra,
	}
	b, err := json.Marshal(w)
	if err == nil {
		return b, nil
	}
	// A value may still fail to encode, for example a json.Marshaler that returns invalid JSON.
	// Such values are written as text so the line isn't lost.
	safe := make(map[string]any, len(r.Extra))
	for k, v := range r.Extra {
		if _, err := json.Marshal(v); err != nil {
			v = fmt.Sprintf("%+v", v)
		}
		safe[k] = v
	}
	w.Extra = safe
	return json.Marshal(w)
}

// wireTimeLayout is the format of a record's time: RFC 3339 in UTC, to the millisecond.
const wireTimeLayout = "2006-01-02T15:04:05.000Z07:00"

func wireTime(t time.Time) string { return t.UTC().Format(wireTimeLayout) }

// handler turns slog records into Records for the log.
type handler struct {
	l      *Log
	pre    []groupedAttr // from WithAttrs
	groups []string      // from WithGroup
}

type groupedAttr struct {
	groups []string
	attr   slog.Attr
}

func (h *handler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= h.l.level.Level()
}

func (h *handler) Handle(ctx context.Context, r slog.Record) error {
	if ctx == nil {
		ctx = context.Background()
	}
	rec := Record{Time: r.Time, Level: r.Level, Message: r.Message}
	for _, ga := range h.pre {
		rec.add(ga.groups, ga.attr)
	}
	r.Attrs(func(a slog.Attr) bool {
		rec.add(h.groups, a)
		return true
	})
	rec.attribute(ctx)
	h.l.Append(rec)
	return nil
}

func (h *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	next := *h
	next.pre = make([]groupedAttr, len(h.pre), len(h.pre)+len(attrs))
	copy(next.pre, h.pre)
	for _, a := range attrs {
		next.pre = append(next.pre, groupedAttr{groups: h.groups, attr: a})
	}
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

// attribute fills the attribution columns from the values that With put on ctx.
func (r *Record) attribute(ctx context.Context) {
	if a, ok := ctx.Value(attributionKey{}).(*attribution); ok {
		a.attribute(r)
	}
	if r.Transfer == "" {
		r.Transfer = transferOfGroup(r.StatsGroup)
	}
}

// add puts one attribute in its own column, or in Extra under its groups.
func (r *Record) add(groups []string, a slog.Attr) {
	a.Value = a.Value.Resolve()
	if a.Equal(slog.Attr{}) {
		return
	}
	if a.Value.Kind() == slog.KindGroup {
		inner := groups
		if a.Key != "" {
			inner = append(groups[:len(groups):len(groups)], a.Key)
		}
		for _, ga := range a.Value.Group() {
			r.add(inner, ga)
		}
		return
	}
	if len(groups) == 0 {
		switch a.Key {
		case "component":
			r.Component = a.Value.String()
			return
		case "subcomponent":
			r.Subcomponent = a.Value.String()
			return
		case "object":
			r.Object = a.Value.String()
			return
		case "objectType":
			r.ObjectType = a.Value.String()
			return
		case "source":
			if a.Value.Kind() == slog.KindString {
				r.Source = a.Value.String()
				return
			}
		case "size":
			if n, ok := intOf(a.Value); ok {
				r.Size = &n
				return
			}
		}
	}
	r.setExtra(groups, a.Key, valueOf(a.Value))
}

func intOf(v slog.Value) (int64, bool) {
	switch v.Kind() {
	case slog.KindInt64:
		return v.Int64(), true
	case slog.KindUint64:
		if u := v.Uint64(); u <= math.MaxInt64 {
			return int64(u), true
		}
	}
	return 0, false
}

func (r *Record) setExtra(groups []string, key string, v any) {
	if r.Extra == nil {
		r.Extra = map[string]any{}
	}
	m := r.Extra
	for _, g := range groups {
		sub, ok := m[g].(map[string]any)
		if !ok {
			sub = map[string]any{}
			m[g] = sub
		}
		m = sub
	}
	m[key] = v
}

// valueOf converts v now to the form it will be encoded in. The writer encodes later on its own
// goroutine, and by then the caller may have changed what it logged.
func valueOf(v slog.Value) (out any) {
	switch v.Kind() {
	case slog.KindString:
		return v.String()
	case slog.KindInt64:
		return v.Int64()
	case slog.KindUint64:
		return v.Uint64()
	case slog.KindFloat64:
		f := v.Float64()
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return strconv.FormatFloat(f, 'g', -1, 64)
		}
		return f
	case slog.KindBool:
		return v.Bool()
	case slog.KindDuration:
		return v.Duration().String()
	case slog.KindTime:
		return v.Time().Format(time.RFC3339Nano)
	}
	defer func() {
		// slog does the same for a LogValuer: a value whose method panics is logged as text
		// instead of crashing.
		if r := recover(); r != nil {
			out = fmt.Sprintf("!PANIC: %v", r)
		}
	}()
	switch x := v.Any().(type) {
	case nil:
		return nil
	case error:
		return x.Error()
	case json.Marshaler:
		if b, err := x.MarshalJSON(); err == nil && json.Valid(b) {
			return json.RawMessage(b)
		}
		return fmt.Sprintf("%+v", x)
	case encoding.TextMarshaler:
		if b, err := x.MarshalText(); err == nil {
			return string(b)
		}
		return fmt.Sprintf("%+v", x)
	case fmt.Stringer:
		return x.String()
	case []byte:
		return string(x)
	default:
		if b, err := json.Marshal(x); err == nil {
			return json.RawMessage(b)
		}
		return fmt.Sprintf("%+v", x)
	}
}
