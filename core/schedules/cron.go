package schedules

import (
	"slices"
	"strings"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/rclone/rclone-ui/core/errs"
)

var parser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

const (
	problemFormat = "Use 5 fields, or @hourly, @daily, @weekly or @monthly."
	problemNever  = "This schedule never runs."
)

// starBit is robfig/cron's mark on a field written as * (or ?).
const starBit = 1 << 63

const horizon = 5 * 366 * 24 * time.Hour

const lookBack = 400 * 24 * time.Hour

const zoneProbe = 24 * time.Hour

type when struct {
	minute, hour, dom, month, dow uint64
}

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

func (w *when) allHours() bool {
	const all = 1<<24 - 1
	return w.hour&all == all
}

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

type civil = time.Time

func civilOf(t time.Time) civil {
	y, mo, d := t.Date()
	return time.Date(y, mo, d, t.Hour(), t.Minute(), 0, 0, time.UTC)
}

func instants(c civil, loc *time.Location) (out []time.Time, skipped bool) {
	_, before := c.Add(-zoneProbe).In(loc).Zone()
	_, after := c.Add(zoneProbe).In(loc).Zone()
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
	t := c.Add(-time.Duration(before) * time.Second).In(loc)
	start, _ := t.ZoneBounds()
	return []time.Time{start}, true
}

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
				if len(out) == 0 || !out[len(out)-1].Equal(t) {
					out = append(out, t)
				}
			}
		}
	}
	slices.SortFunc(out, time.Time.Compare)
	return slices.CompactFunc(out, time.Time.Equal)
}

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
		if len(out) >= n && day.After(civilOf(out[n-1].In(loc)).Add(24*time.Hour)) {
			break
		}
	}
	slices.SortFunc(out, time.Time.Compare)
	out = slices.CompactFunc(out, time.Time.Equal)
	return out[:min(n, len(out))]
}
