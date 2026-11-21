package schedules

import (
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/errs"
)

func bucharest(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Bucharest")
	if err != nil {
		t.Skip("no zoneinfo:", err)
	}
	return loc
}

func mustWhen(t *testing.T, expr string) *when {
	t.Helper()
	w, err := parseWhen(expr)
	if err != nil {
		t.Fatalf("%s: %v", expr, err)
	}
	return w
}

func stamps(ts []time.Time) string {
	var out []string
	for _, t := range ts {
		out = append(out, t.Format("2006-01-02 15:04 -07"))
	}
	return strings.Join(out, ", ")
}

// TestParseWhen covers the formats that the parser accepts and the app refuses.
func TestParseWhen(t *testing.T) {
	for _, ok := range []string{"0 2 * * *", "*/15 * * * *", "0 9 * * MON-FRI", "30 3 1 * *", "@hourly", "@daily",
		"@weekly", "@monthly", " 0 2 * * * ", "0 2 31 2 *"} {
		if _, err := parseWhen(ok); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"@yearly", "@annually", "@midnight", "@every 5m", "@reboot", "TZ=UTC 0 2 * * *",
		"CRON_TZ=UTC 0 2 * * *", "0 0 2 * * *", "*/0 * * * *", "60 * * * *", "0 2 * *", "nonsense", "0 25 * * *"} {
		_, err := parseWhen(bad)
		if err == nil || errs.FieldOf(err) != "when" || err.Error() != problemFormat {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if _, err := parseWhen(""); err == nil || errs.FieldOf(err) != "when" {
		t.Errorf("empty: %v", err)
	}
	if _, err := checkWhen("0 2 31 2 *", time.Now(), time.UTC); err == nil || err.Error() != problemNever {
		t.Errorf("31 February: %v", err)
	}
}

// TestNext lists the next times, in order, with weekdays and descriptors.
func TestNext(t *testing.T) {
	loc := bucharest(t)
	from := time.Date(2026, 11, 6, 12, 0, 0, 0, loc) // a Friday
	for _, c := range []struct{ expr, want string }{
		{"0 2 * * *", "2026-11-07 02:00 +02, 2026-11-08 02:00 +02, 2026-11-09 02:00 +02"},
		{"0 9 * * MON-FRI", "2026-11-09 09:00 +02, 2026-11-10 09:00 +02, 2026-11-11 09:00 +02"},
		{"@hourly", "2026-11-06 13:00 +02, 2026-11-06 14:00 +02, 2026-11-06 15:00 +02"},
		{"@monthly", "2026-12-01 00:00 +02, 2027-01-01 00:00 +02, 2027-02-01 00:00 +02"},
		{"* * * * *", "2026-11-06 12:01 +02, 2026-11-06 12:02 +02, 2026-11-06 12:03 +02"},
		{"0 0 29 2 *", "2028-02-29 00:00 +02"}, // the next is past the horizon
	} {
		if got := stamps(mustWhen(t, c.expr).next(from, 3, loc)); got != c.want {
			t.Errorf("%s: %s, want %s", c.expr, got, c.want)
		}
	}
	if got := mustWhen(t, "0 2 31 2 *").next(from, 3, loc); len(got) != 0 {
		t.Errorf("31 February runs: %s", stamps(got))
	}
}

// TestDaylightSaving checks the two rules on daylight saving. On 29 March 2026 the clocks in
// Bucharest go from 03:00 to 04:00, and on 25 October 2026 from 04:00 back to 03:00.
func TestDaylightSaving(t *testing.T) {
	loc := bucharest(t)
	for _, c := range []struct {
		name, expr string
		from       time.Time
		want       string
	}{
		{"a skipped time runs once, just after the change", "30 3 * * *", time.Date(2026, 3, 28, 12, 0, 0, 0, loc),
			"2026-03-29 04:00 +03, 2026-03-30 03:30 +03, 2026-03-31 03:30 +03"},
		{"a repeated time runs once", "30 3 * * *", time.Date(2026, 10, 24, 12, 0, 0, 0, loc),
			"2026-10-25 03:30 +03, 2026-10-26 03:30 +02, 2026-10-27 03:30 +02"},
		{"hourly runs once at the skipped hour", "0 * * * *", time.Date(2026, 3, 29, 1, 30, 0, 0, loc),
			"2026-03-29 02:00 +02, 2026-03-29 04:00 +03, 2026-03-29 05:00 +03"},
		{"hourly keeps both repeated hours", "0 * * * *", time.Date(2026, 10, 25, 2, 30, 0, 0, loc),
			"2026-10-25 03:00 +03, 2026-10-25 03:00 +02, 2026-10-25 04:00 +02"},
	} {
		if got := stamps(mustWhen(t, c.expr).next(c.from, 3, loc)); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}

// TestLatest checks that missed times give only the latest, and the rules on daylight saving.
func TestLatest(t *testing.T) {
	loc := bucharest(t)
	at := func(mo time.Month, d, h, m int) time.Time { return time.Date(2026, mo, d, h, m, 0, 0, loc) }
	daily := mustWhen(t, "0 2 * * *")
	if got := daily.latest(at(11, 1, 12, 0), at(11, 6, 12, 0), loc); !got.Equal(at(11, 6, 2, 0)) {
		t.Errorf("five missed days: %v", got)
	}
	if got := daily.latest(at(11, 6, 2, 0), at(11, 6, 12, 0), loc); !got.IsZero() {
		t.Errorf("the time already dealt with: %v", got)
	}
	if got := daily.latest(at(11, 6, 1, 59), at(11, 6, 2, 0), loc); !got.Equal(at(11, 6, 2, 0)) {
		t.Errorf("at the time: %v", got)
	}
	if got := daily.latest(at(11, 6, 12, 0), at(11, 6, 11, 0), loc); !got.IsZero() {
		t.Errorf("now before after: %v", got)
	}
	// 29 March: 03:30 doesn't exist, so it is due at 04:00.
	skipped := mustWhen(t, "30 3 * * *")
	if got := skipped.latest(at(3, 29, 3, 59).Add(-time.Hour), at(3, 29, 4, 0), loc); got.Format("15:04 -07") != "04:00 +03" {
		t.Errorf("skipped time: %v", got)
	}
	// 25 October: the second 03:30 isn't due.
	first := time.Date(2026, 10, 25, 0, 30, 0, 0, time.UTC) // 03:30 +03
	if got := skipped.latest(first, first.Add(90*time.Minute), loc); !got.IsZero() {
		t.Errorf("the repeated time ran again at %v", got)
	}
	hourly := mustWhen(t, "0 * * * *")
	if got := hourly.latest(first, first.Add(40*time.Minute), loc); got.Format("15:04 -07") != "03:00 +02" {
		t.Errorf("hourly's second 03:00: %v", got)
	}
}
