package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
)

// templatesOf runs templates as the templates service does, from a map of id to
// operations.TemplateArgs's arguments.
type templatesOf map[string]struct {
	tags             []operations.Operation
	sources          []string
	destination, opt string
}

func (ts templatesOf) Run(_ context.Context, id string, tag operations.Operation) (operations.Form, string, error) {
	t, ok := ts[id]
	if !ok || !slices.Contains(t.tags, tag) {
		return operations.Form{}, "", errs.New("This template has no paths to run for this operation: apply it in its form.")
	}
	var options catalog.Group
	if err := json.Unmarshal([]byte(t.opt), &options); err != nil {
		return operations.Form{}, "", err
	}
	f, err := operations.TemplateArgs(tag, t.sources, t.destination, options)
	return f, "Template " + id, err
}

// A template runs as one of its tags, with the template as its origin and a preset that reopens
// the operation's page.
func TestStartTemplate(t *testing.T) {
	f := newFixture(t)
	src, dst := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(src, "a.txt"), 10)
	writeFile(t, filepath.Join(src, "b.log"), 10)
	api := NewAPI(late.Of(f.s), late.Of[Templates](templatesOf{
		"t":   {tags: []operations.Operation{"copy", "sync"}, sources: []string{src}, destination: dst, opt: `{"exclude": ["*.log"], "transfers": 2}`},
		"two": {tags: []operations.Operation{"sync"}, sources: []string{src, src + "2"}, destination: dst, opt: `{}`},
	}))

	started, err := api.StartTemplate(f.ctx, "t", "copy")
	if err != nil {
		t.Fatal(err)
	}
	tr := f.wait(started.ID)
	if tr.State != StateCompleted || tr.Operation != "copy" ||
		tr.Origin != (Origin{Kind: OriginTemplate, ID: "t", Name: "Template t"}) {
		t.Fatalf("ran %+v", tr)
	}
	if _, err := os.Stat(filepath.Join(dst, filepath.Base(src), "a.txt")); err != nil {
		t.Errorf("not copied: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dst, filepath.Base(src), "b.log")); err == nil {
		t.Error("the template's filter was not applied")
	}
	if !Resumable(Transfer{State: StateRunning, Operation: "copy", Origin: tr.Origin}) {
		t.Error("a template's run is not resumable")
	}
	d, err := api.Get(f.ctx, started.ID)
	if err != nil {
		t.Fatal(err)
	}
	if p := d.Preset; p == nil || p.Operation != "copy" || p.Copy == nil ||
		!slices.Equal(p.Copy.Sources, []string{src}) || p.Copy.Destination != dst {
		t.Errorf("preset %+v", p)
	}

	for _, c := range []struct {
		id   string
		tag  operations.Operation
		want string
	}{
		{"t", "move", "This template has no paths to run for this operation: apply it in its form."},
		{"two", "sync", "The template needs one source to run."},
	} {
		_, err := api.StartTemplate(f.ctx, c.id, c.tag)
		if e := rclone.ErrorOf(err); e.Code != errs.CodeInvalid || e.Message != c.want {
			t.Errorf("%s as %s: %v, want %q", c.id, c.tag, err, c.want)
		}
	}
}

// A start that failed after its transfer was recorded carries the transfer. A first bisync that
// rclone refused, because the folders have no baseline yet, is a precondition that names the
// baseline, so that the Bisync page can offer a resync.
func TestStartedFirstBisync(t *testing.T) {
	st := Started{ID: "t1", Seq: 4}
	for _, c := range []struct {
		err        string
		code       errs.Code
		what       string
		transfer   bool
		recordedAs Started
	}{
		{"cannot find prior Path1 or Path2 listings: bisync aborted", errs.CodePrecondition, operations.WhatBisyncBaseline, true, st},
		{"directory not found", errs.CodeFailed, "", true, st},
		// Only the start of the error counts, as for the watchers and the schedules.
		{"sync: cannot find prior Path1 or Path2 listings", errs.CodeFailed, "", true, st},
		// A start that recorded nothing carries no transfer.
		{"cannot find prior Path1 or Path2 listings: bisync aborted", errs.CodeFailed, "", false, Started{}},
	} {
		_, err := started(c.recordedAs, errors.New(c.err))
		e := rclone.ErrorOf(err)
		if e.Code != c.code || e.What != c.what || e.Message != c.err {
			t.Errorf("%q: %+v, want %s %q", c.err, e, c.code, c.what)
		}
		if got := e.Transfer != nil && *e.Transfer == (errs.TransferRef{ID: st.ID, Seq: st.Seq}); got != c.transfer {
			t.Errorf("%q: transfer %+v", c.err, e.Transfer)
		}
	}

	// The same through the API, with rclone's own refusal of a first bisync.
	f := newFixture(t)
	one, two := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(one, "a.txt"), 1)
	api := NewAPI(late.Of(f.s), late.Of[Templates](templatesOf{}))
	_, err := api.Start(f.ctx, operations.BisyncArgs{Source: one, Destination: two}.Form(), StartOptions{Origin: OriginPage})
	e := rclone.ErrorOf(err)
	if e.Code != errs.CodePrecondition || e.What != operations.WhatBisyncBaseline || e.Transfer == nil {
		t.Fatalf("a first bisync: %+v", e)
	}
	if tr := f.wait(e.Transfer.ID); tr.State != StateFailed || !operations.IsFirstRun(tr.Error) {
		t.Errorf("recorded %s %q", tr.State, tr.Error)
	}
}

// Start takes a page's form. The Commander's renames and folder deletes, the launcher's cleanup,
// and the forms that only presets hold don't start through it, and nothing is recorded for them.
func TestStartRefusesWhatNoPageStarts(t *testing.T) {
	f := newFixture(t)
	api := NewAPI(late.Of(f.s), late.Of[Templates](templatesOf{}))
	dir := t.TempDir()
	for _, form := range []operations.Form{
		operations.RenameArgs{Items: []operations.RenameItem{{Path: dir + "/a", NewName: "b"}}}.Form(),
		operations.FolderArgs{Path: dir}.Form(),
		operations.CleanupArgs{Remote: dir}.Form(),
		operations.MountArgs{Source: dir, Destination: dir}.Form(),
		{Operation: "format"},
	} {
		if _, err := api.Start(f.ctx, form, StartOptions{Origin: OriginPage}); rclone.ErrorOf(err).Code != errs.CodeInvalid {
			t.Errorf("%s: %v", form.Operation, err)
		}
		if err := api.Check(f.ctx, form); rclone.ErrorOf(err).Code != errs.CodeInvalid {
			t.Errorf("%s's check: %v", form.Operation, err)
		}
	}
	// A page starts its transfer as a page's or the Commander's. Templates, watchers and schedules
	// start their own runs, so a page can't pass for one of them.
	copied := operations.CopyArgs{Sources: []string{dir}, Destination: t.TempDir()}.Form()
	for _, origin := range []OriginKind{OriginWatcher, OriginSchedule, OriginTemplate, "", "operation"} {
		_, err := api.Start(f.ctx, copied, StartOptions{Origin: origin})
		if e := rclone.ErrorOf(err); e.Code != errs.CodeInvalid || len(e.Fields) != 1 || e.Fields[0].Field != "origin" {
			t.Errorf("origin %q: %+v", origin, e)
		}
	}
	// A page's form is checked as Start would check it.
	if err := api.Check(f.ctx, operations.DeleteArgs{Sources: []string{dir, "/"}}.Form()); err == nil {
		t.Error("a delete of a root passed")
	}
	if err := api.Check(f.ctx, operations.CopyArgs{Sources: []string{dir}, Destination: dir + "/out"}.Form()); err != nil {
		t.Errorf("a copy: %v", err)
	}
	if _, err := api.Command(f.ctx, operations.SaveArgs{Source: dir, Destination: dir}.Form()); rclone.ErrorOf(err).Code != errs.CodeInvalid {
		t.Errorf("a save's command: %v", err)
	}
	if _, err := api.Landings(f.ctx, "sync", operations.CopyArgs{}); rclone.ErrorOf(err).Code != errs.CodeInvalid {
		t.Errorf("a sync's landings: %v", err)
	}
	if active, _ := f.s.Active(f.ctx); len(active) != 0 {
		t.Errorf("recorded %v", active)
	}
}
