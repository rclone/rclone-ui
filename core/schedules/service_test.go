package schedules

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

// Save refuses a missing or used name and a time the app doesn't accept, as field errors on name
// and when. A form that a run would refuse comes back as one message, not a field error. A save
// that only renames a schedule or changes its time doesn't check the form again.
func TestSaveChecks(t *testing.T) {
	r := &fakeRunner{}
	f := newFixture(t, r)
	ctx := context.Background()
	args := copyArgs([]string{"/a"}, "/b")
	for _, c := range []struct {
		in          Input
		field, text string
	}{
		{Input{Name: " ", Form: form("copy", args), When: "@daily"}, "name", "Please enter a name for the schedule"},
		{Input{Name: "X", Form: form("copy", args), When: "@yearly"}, "when", problemFormat},
		{Input{Name: "X", Form: form("copy", args), When: "0 0 30 2 *"}, "when", problemNever},
		{Input{Name: "X", Form: form("copy", args), When: ""}, "when", "Please choose when the schedule runs."},
		{Input{Name: "X", Form: operations.Form{Operation: operations.OperationMount}, When: "@daily"}, "", "A schedule can run a copy, move, sync, bisync, delete or purge."},
		{Input{Name: "X", Form: operations.Form{Operation: operations.OperationCopy, Sync: &operations.SyncArgs{}}, When: "@daily"}, "", "a copy form with the arguments of a sync"},
	} {
		_, err := f.s.Save(ctx, c.in)
		if err == nil || errs.FieldOf(err) != c.field || err.Error() != c.text {
			t.Errorf("%+v: %v (field %q)", c.in, err, errs.FieldOf(err))
		}
	}
	sc := f.save(Input{Name: " Photos ", Form: form("copy", args), When: " @daily "})
	if sc.Name != "Photos" || sc.When != "@daily" || r.checks != 1 {
		t.Errorf("saved: %+v, %d checks", sc, r.checks)
	}
	if _, err := f.s.Save(ctx, Input{Name: "photos", Form: form("copy", args), When: "@daily"}); errs.FieldOf(err) != "name" ||
		err.Error() != "A schedule called photos exists already." {
		t.Errorf("a used name: %v", err)
	}
	// A rename and a new time, while the remote is offline: no check.
	r.checkErr = errors.New("couldn't connect")
	f.save(Input{ID: sc.ID, Name: "Pictures", Form: form("copy", copyArgs([]string{"/a"}, "/b")), When: "@hourly"})
	if r.checks != 1 {
		t.Errorf("a rename checked the form: %d checks", r.checks)
	}
	// A new form is checked, and its refusal is one message.
	r.checkErr = errs.Field("options.copy", "‘nope’ is not an option of copy")
	_, err := f.s.Save(ctx, Input{ID: sc.ID, Name: "Pictures", Form: form("copy", copyArgs([]string{"/a"}, "/c")), When: "@hourly"})
	if err == nil || errs.FieldOf(err) != "" || err.Error() != "‘nope’ is not an option of copy" {
		t.Errorf("a refused form: %v (field %q)", err, errs.FieldOf(err))
	}
	if _, err := f.s.Save(ctx, Input{ID: "gone", Name: "Gone", Form: form("copy", args), When: "@daily"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("an edit of a deleted schedule: %v", err)
	}
	if len(f.published(bus.SchedulesChanged)) == 0 {
		t.Error("schedules.changed was never published")
	}
}

// Save drops what is for a single run: a dry run in any option group (a dry run notifies nobody,
// so a schedule of one would do nothing), and Bisync's resync, force and dry run.
func TestSaveCleansTheForm(t *testing.T) {
	f := newFixture(t, &fakeRunner{})
	sc := f.save(Input{Name: "Copy", Form: form("copy", json.RawMessage(`{"sources":["/a"],"destination":"/b","options":{"config":{"dry_run":true,"transfers":8},"copy":{"--dry-run":true},"filter":{"include":["*.jpg"]}}}`)), When: "@daily"})
	if got := argsOf(sc); got != `{"sources":["/a"],"destination":"/b","options":{"filter":{"include":["*.jpg"]},"config":{"transfers":8}}}` {
		t.Errorf("copy: %s", got)
	}
	sc = f.save(Input{Name: "Bisync", Form: form("bisync", json.RawMessage(`{"source":"/a","destination":"/b","options":{"outer":{"resync":true,"resyncMode":"path1","force":true,"dryRun":false,"conflictResolve":"newer"},"config":{"--dry-run":"true"}}}`)), When: "@daily"})
	if got := argsOf(sc); got != `{"source":"/a","destination":"/b","options":{"outer":{"conflictResolve":"newer"}}}` {
		t.Errorf("bisync: %s", got)
	}
	f2 := form("bisync", json.RawMessage(`{"options":{"sync":{"dry-run":true},"outer":{"force":true,"resync":false}}}`))
	if got := clean(&f2); len(got) != 2 || got[0] != "Dry run" || got[1] != "Force" {
		t.Errorf("dropped: %v", got)
	}
}

// Duplicate copies a schedule as "{name} copy", then "copy 2", paused.
func TestDuplicate(t *testing.T) {
	f := newFixture(t, &fakeRunner{})
	sc := daily(f, "Photos")
	one, err := f.s.Duplicate(context.Background(), sc.ID)
	testutil.Must(t, err)
	two, err := f.s.Duplicate(context.Background(), sc.ID)
	testutil.Must(t, err)
	if one.Name != "Photos copy" || two.Name != "Photos copy 2" || !one.Paused || !two.Paused || one.NextRun != nil ||
		argsOf(one) != argsOf(sc) || one.When != sc.When || one.ID == sc.ID {
		t.Errorf("copies: %+v %+v", one, two)
	}
}

// Describe gives the next 3 times with the zone's abbreviation, or the problem.
func TestDescribe(t *testing.T) {
	loc := bucharest(t)
	f := newFixture(t, &fakeRunner{}, func(o *Options) { o.Location = loc })
	d := f.s.Describe("0 2 * * *")
	if d.Problem != "" || d.Zone != "EET" || len(d.Next) != 3 ||
		time.UnixMilli(d.Next[0]).In(loc).Format("Mon 2 Jan 15:04") != "Sat 7 Nov 02:00" {
		t.Errorf("good: %+v", d)
	}
	for expr, want := range map[string]string{"@every 5m": problemFormat, "0 2 30 2 *": problemNever, "bad": problemFormat} {
		if d := f.s.Describe(expr); d.Problem != want || len(d.Next) != 0 {
			t.Errorf("%s: %+v", expr, d)
		}
	}
}

// Pause and Resume of a schedule that doesn't exist say so.
func TestNotFound(t *testing.T) {
	f := newFixture(t, &fakeRunner{})
	ctx := context.Background()
	for _, fn := range []func(context.Context, string) error{f.s.Pause, f.s.Resume, f.s.Delete, f.s.RunNow, f.s.MergeAgain} {
		if err := fn(ctx, "nope"); !errors.Is(err, ErrNotFound) {
			t.Errorf("%v", err)
		}
	}
	if err := f.s.MergeAgain(ctx, daily(f, "Copy").ID); err == nil || !errs.Is(err) {
		t.Errorf("merging a copy: %v", err)
	}
}

// A remote's rename rewrites the paths, the keys of the remotes options, the option values that
// name a path on it, and a bisync's outer backup folders. A bisync whose paths changed is no
// longer baselined, and one whose paths didn't change keeps its baseline.
func TestRenameRemote(t *testing.T) {
	f := newFixture(t, &fakeRunner{})
	ctx := context.Background()
	cp := f.save(Input{Name: "Copy", Form: form("copy", json.RawMessage(`{"sources":["gdrive:Photos","/local"],
		"destination":"s3:b","options":{"remotes":{"gdrive":{"chunk_size":"64M"}},"copy":{"backup_dir":"gdrive:old","transfers":4}}}`)), When: "@daily"})
	bi := f.save(Input{Name: "Bisync", Form: form("bisync", json.RawMessage(`{"source":"gdrive:A","destination":"/b"}`)), When: "@daily"})
	backups := f.save(Input{Name: "Backups", Form: form("bisync", json.RawMessage(`{"source":"/a","destination":"/b",
		"options":{"outer":{"backupDir1":"gdrive:one","backupDir2":"s3:two"}}}`)), When: "@daily"})
	other := f.save(Input{Name: "Other", Form: form("copy", copyArgs([]string{"/x"}, "gdrivex:y")), When: "@daily"})
	testutil.Must(t, f.s.update(ctx, bi.ID, `baselined = 1`))
	testutil.Must(t, f.s.update(ctx, backups.ID, `baselined = 1`))
	testutil.Must(t, f.s.RenameRemote(ctx, "gdrive", "drive"))
	if got := argsOf(f.get(cp.ID)); got !=
		`{"sources":["drive:Photos","/local"],"destination":"s3:b","options":{"copy":{"backup_dir":"drive:old","transfers":4},"remotes":{"drive":{"chunk_size":"64M"}}}}` {
		t.Errorf("copy: %s", got)
	}
	if got := f.get(bi.ID); argsOf(got) != `{"source":"drive:A","destination":"/b"}` || got.Baselined {
		t.Errorf("bisync: %+v", got)
	}
	if got := f.get(backups.ID); argsOf(got) != `{"source":"/a","destination":"/b","options":{"outer":{"backupDir1":"drive:one","backupDir2":"s3:two"}}}` ||
		!got.Baselined {
		t.Errorf("bisync's backup folders: %s, baselined %v", argsOf(got), got.Baselined)
	}
	if got := argsOf(f.get(other.ID)); got != argsOf(other) {
		t.Errorf("another remote was rewritten: %s", got)
	}
}

// Changing a bisync's folders clears its baseline. Changing its other options doesn't.
func TestBisyncEditClearsTheBaseline(t *testing.T) {
	f := newFixture(t, &fakeRunner{})
	ctx := context.Background()
	in := Input{Name: "B", Form: form("bisync", json.RawMessage(`{"source":"/a","destination":"/b"}`)), When: "@daily"}
	sc := f.save(in)
	testutil.Must(t, f.s.update(ctx, sc.ID, `baselined = 1`))
	in.ID = sc.ID
	in.Form = form("bisync", json.RawMessage(`{"source":"/a","destination":"/b","options":{"outer":{"conflictResolve":"older"}}}`))
	if !f.save(in).Baselined {
		t.Error("an option's change cleared the baseline")
	}
	in.Form = form("bisync", json.RawMessage(`{"source":"/a","destination":"/c"}`))
	if f.save(in).Baselined {
		t.Error("a new folder kept the baseline")
	}
}

func TestSaveWarnsAboutAWatcher(t *testing.T) {
	f := newFixture(t, &fakeRunner{}, func(o *Options) { o.Watchers = keeps{"/a", "/b"} })
	sc := f.save(Input{Name: "B", Form: form("bisync", json.RawMessage(`{"source":"/b","destination":"/a"}`)), When: "@daily"})
	if sc.Warning != "A watcher already keeps these two folders the same." {
		t.Errorf("warning: %q", sc.Warning)
	}
	if got := f.get(sc.ID); got.Warning != "" {
		t.Errorf("the warning was stored: %q", got.Warning)
	}
	if sc := f.save(Input{Name: "C", Form: form("copy", copyArgs([]string{"/a"}, "/b")), When: "@daily"}); sc.Warning != "" {
		t.Errorf("a copy was warned about: %q", sc.Warning)
	}
}

type keeps [2]string

func (k keeps) Keeps(_ context.Context, a, b string) (bool, error) {
	return a == k[0] && b == k[1] || a == k[1] && b == k[0], nil
}

func TestActive(t *testing.T) {
	f := newFixture(t, &fakeRunner{})
	ctx := context.Background()
	a, _ := daily(f, "A"), daily(f, "B")
	testutil.Must(t, f.s.Pause(ctx, a.ID))
	if n, err := f.s.Active(ctx); err != nil || n != 1 {
		t.Errorf("%d, %v", n, err)
	}
}

// A page that asks about a schedule that doesn't exist gets not_found, not invalid.
func TestAPINotFound(t *testing.T) {
	f := newFixture(t, &fakeRunner{})
	ctx := context.Background()
	api := NewAPI(late.Of(f.s))
	_, getErr := api.Get(ctx, "nope")
	_, dupErr := api.Duplicate(ctx, "nope")
	_, saveErr := api.Save(ctx, Input{ID: "nope", Name: "Gone", Form: form("copy", copyArgs([]string{"/a"}, "/b")), When: "@daily"})
	for name, err := range map[string]error{
		"Get": getErr, "Duplicate": dupErr, "Save": saveErr,
		"Delete": api.Delete(ctx, "nope"), "Pause": api.Pause(ctx, "nope"), "Resume": api.Resume(ctx, "nope"),
		"RunNow": api.RunNow(ctx, "nope"), "MergeAgain": api.MergeAgain(ctx, "nope"),
	} {
		if e := rclone.ErrorOf(err); e == nil || e.Code != errs.CodeNotFound || e.What != "schedule" {
			t.Errorf("%s: %+v", name, e)
		}
	}
}
