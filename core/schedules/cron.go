package schedules

import (
	"slices"
	"strings"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/rclone/rclone-ui/core/errs"
)

// The cron expressions that the app accepts are 5 fields (minute, hour, day of month, month and
// day of week, with names such as MON-FRI), or @hourly, @daily, @weekly and @monthly. They are
// read with robfig/cron's parser, and only its fields are used: the times are worked out here, on
// the wall clock, so that daylight saving follows two rules, as classic cron does:
//
//   - A time that the clocks skip (03:30 when they go from 03:00 to 04:00) runs once, just after
//     the change.
//   - A time that happens twice (03:30 when they go back from 04:00 to 03:00) runs once, the
//     first time, unless the hour field covers all 24 hours. So an hourly schedule keeps both.

// parser reads the five fields and the descriptors.
var parser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

// The problems with an expression, shown under the "When" field.
const (
	problemFormat = "Use 5 fields, or @hourly, @daily, @weekly or @monthly."
	problemNever  = "This schedule never runs."
)

// starBit is robfig/cron's mark on a field written as * (or ?).
const starBit = 1 << 63

// horizon is how far ahead the next run is looked for. An expression with none in this time
// never runs (31 February).
const horizon = 5 * 366 * 24 * time.Hour

// lookBack limits how far back a due time is looked for, after the app was closed a long time.
const lookBack = 400 * 24 * time.Hour

// when is a parsed cron expression.
type when struct {
	minute, hour, dom, month, dow uint64
}

// parseWhen reads a cron expression, and refuses what the app doesn't accept. Its error is a
// field error on "when".
func parseWhen(expr string) (*when, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return nil, errs.Field("when", "Please choose when the schedule runs.")
	}
	if strings.HasPrefix(expr, "@") {
		if !slices.Contains([]string{"@hourly", "@daily", "@weekly", "@monthly"}, expr) {
			return nil, errs.Field("when", problemFormat)
		}
	} else if len(strings.Fields(expr)) != 5 || strings.Contains(expr, "=") {
		// TZ= and CRON_TZ= prefixes: the app runs in the computer's zone.
		return nil, errs.Field("when", problemFormat)
	}
	s, err := parser.Parse(expr)
	if err != nil {
		return nil, errs.Field("when", problemFormat)
	}
	spec, ok := s.(*cron.SpecSchedule)
	if !ok {
		return nil, errs.Field("when", problemFormat)
	}
	return &when{minute: spec.Minute, hour: spec.Hour, dom: spec.Dom, month: spec.Month, dow: spec.Dow}, nil
}

// checkWhen parses expr and refuses one that never runs.
func checkWhen(expr string, now time.Time, loc *time.Location) (*when, error) {
	w, err := parseWhen(expr)
	if err != nil {
		return nil, err
	}
	if len(w.next(now, 1, loc)) == 0 {
		return nil, errs.Field("when", problemNever)
	}
	return w, nil
}

// allHours reports whether the hour field covers all 24 hours (*, 0-23, */1).
func (w *when) allHours() bool {
	const all = 1<<24 - 1
	return w.hour&all == all
}

// dayMatches reports whether a day matches the day fields. As in cron, when both the day of month
// and the day of week are restricted, either one matching is enough.
func (w *when) dayMatches(day time.Time) bool {
	if 1<<uint(day.Month())&w.month == 0 {
		return false
	}
	dom := 1<<uint(day.Day())&w.dom != 0
	dow := 1<<uint(day.Weekday())&w.dow != 0
	if w.dom&starBit != 0 || w.dow&starBit != 0 {
		return dom && dow
	}
	return dom || dow
}

// civil is a wall-clock date and time, held as a UTC time so that adding to it ignores zones.
type civil = time.Time

func civilOf(t time.Time) civil {
	y, mo, d := t.Date()
	return time.Date(y, mo, d, t.Hour(), t.Minute(), 0, 0, time.UTC)
}

// instants returns the moments when the wall clock of loc shows c: none when the clocks skip it,
// two when they go back over it, and one otherwise. For a skipped time, it returns the moment of
// the change instead, with skipped set. The offsets on each side are read a day away, since two
// changes are always further apart than that.
func instants(c civil, loc *time.Location) (out []time.Time, skipped bool) {
	_, before := c.Add(-24 * time.Hour).In(loc).Zone() // approximate, but a day off is enough
	_, after := c.Add(24 * time.Hour).In(loc).Zone()
	for _, off := range []int{before, after} {
		t := c.Add(-time.Duration(off) * time.Second).In(loc)
		if civilOf(t).Equal(c) && !slices.ContainsFunc(out, t.Equal) {
			out = append(out, t)
		}
	}
	if len(out) > 0 {
		slices.SortFunc(out, time.Time.Compare)
		return out, false
	}
	// Skipped: the change happened at the start of the zone period that this wall time falls in,
	// read with the offset from before the change.
	t := c.Add(-time.Duration(before) * time.Second).In(loc)
	start, _ := t.ZoneBounds()
	return []time.Time{start}, true
}

// dayTimes returns the scheduled moments of the wall-clock day that starts at day, in order, with
// the two rules on daylight saving.
func (w *when) dayTimes(day civil, loc *time.Location) []time.Time {
	if !w.dayMatches(day) {
		return nil
	}
	var out []time.Time
	for h := range 24 {
		if 1<<uint(h)&w.hour == 0 {
			continue
		}
		for m := range 60 {
			if 1<<uint(m)&w.minute == 0 {
				continue
			}
			ts, _ := instants(day.Add(time.Duration(h)*time.Hour+time.Duration(m)*time.Minute), loc)
			if len(ts) == 2 && !w.allHours() {
				ts = ts[:1]
			}
			for _, t := range ts {
				// The skipped times of a change all give its moment, one after the other.
				if len(out) == 0 || !out[len(out)-1].Equal(t) {
					out = append(out, t)
				}
			}
		}
	}
	slices.SortFunc(out, time.Time.Compare)
	return slices.CompactFunc(out, time.Time.Equal)
}

// latest returns the latest scheduled moment in (after, now], or the zero time when there is
// none. Many missed moments give only the latest.
func (w *when) latest(after, now time.Time, loc *time.Location) time.Time {
	if !now.After(after) {
		return time.Time{}
	}
	if now.Sub(after) > lookBack {
		after = now.Add(-lookBack)
	}
	first := civilOf(after.In(loc)).Truncate(24 * time.Hour).Add(-24 * time.Hour)
	for day := civilOf(now.In(loc)).Truncate(24 * time.Hour).Add(24 * time.Hour); !day.Before(first); day = day.Add(-24 * time.Hour) {
		ts := w.dayTimes(day, loc)
		for i := len(ts) - 1; i >= 0; i-- {
			if !ts[i].After(now) && ts[i].After(after) {
				return ts[i]
			}
		}
	}
	return time.Time{}
}

// next returns the first n scheduled moments after after. It returns fewer when there are fewer
// within the horizon.
func (w *when) next(after time.Time, n int, loc *time.Location) []time.Time {
	var out []time.Time
	last := civilOf(after.Add(horizon).In(loc))
	for day := civilOf(after.In(loc)).Truncate(24 * time.Hour).Add(-24 * time.Hour); !day.After(last); day = day.Add(24 * time.Hour) {
		for _, t := range w.dayTimes(day, loc) {
			if t.After(after) {
				out = append(out, t)
			}
		}
		if len(out) < n {
			continue
		}
		slices.SortFunc(out, time.Time.Compare)
		out = slices.CompactFunc(out, time.Time.Equal)
		// A day's moments can come before the previous day's only around a change, so the
		// search stops a day after the nth.
		if len(out) >= n && day.After(civilOf(out[n-1].In(loc)).Add(24*time.Hour)) {
			break
		}
	}
	slices.SortFunc(out, time.Time.Compare)
	out = slices.CompactFunc(out, time.Time.Equal)
	return out[:min(n, len(out))]
}
