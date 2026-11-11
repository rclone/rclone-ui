package schedules

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/operations"
)

// clean removes what is for a single run from a form, and returns the names of what it removed:
// "Dry run", "Resync" and "Force", each when it was on. A dry run is removed from every option
// group, however it is spelled, and so are bisync's resync, force and dry run. Its resync mode is
// removed too, because only a resync reads it. The form's groups are changed in place.
func clean(f *operations.Form) []string {
	var dropped []string
	drop := func(label string, on bool) {
		if on && !slices.Contains(dropped, label) {
			dropped = append(dropped, label)
		}
	}
	g := f.Groups()
	if g == nil {
		return nil
	}
	for _, group := range g.Named() {
		for key, v := range group {
			if catalog.NormalizeOptionName(key) == "dry_run" {
				delete(group, key)
				drop("Dry run", on(v))
			}
		}
	}
	if outer := g.Outer; outer != nil {
		drop("Dry run", outer.DryRun)
		drop("Resync", outer.Resync)
		drop("Force", outer.Force)
		outer.DryRun, outer.Resync, outer.Force, outer.ResyncMode = false, false, false, ""
	}
	return dropped
}

// LeftOff returns the names of what a schedule saved from f leaves off, because it is for a single
// run (clean): "Dry run", "Resync" and "Force". The schedule drawer shows them before it saves.
// f is not changed.
func LeftOff(f operations.Form) ([]string, error) {
	// A round trip through the stored form copies the groups, which clean changes.
	raw, err := f.MarshalArgs()
	if err != nil {
		return nil, err
	}
	c, err := operations.DecodeForm(f.Operation, raw)
	if err != nil {
		return nil, err
	}
	dropped := clean(&c)
	if dropped == nil {
		dropped = []string{}
	}
	return dropped, nil
}

// on reports whether an option's value is a true switch: true, or the text "true".
func on(v json.RawMessage) bool {
	var b bool
	if json.Unmarshal(v, &b) == nil {
		return b
	}
	var s string
	return json.Unmarshal(v, &s) == nil && strings.EqualFold(s, "true")
}

// unattended returns a bisync form set up to run with nobody watching
// (operations.UnattendedBisync). merge makes it a merge of the two folders, newer wins, which
// deletes nothing. The form f is not changed.
func unattended(f operations.Form, merge bool, workdir string) operations.Form {
	var a operations.BisyncArgs
	if f.Bisync != nil {
		a = *f.Bisync
	}
	var switches operations.BisyncSwitches
	if a.Options.Outer != nil {
		switches = *a.Options.Outer
	}
	switches = operations.UnattendedBisync(switches, merge, workdir)
	a.Options.Outer = &switches
	return a.Form()
}

// withoutSource returns the form of a Move, Delete or Purge without the source path, and how
// many sources are left. The form f is not changed. Other operations have no list of sources to
// shorten, so their form comes back as it is, with no source left.
func withoutSource(f operations.Form, path string) (operations.Form, int) {
	without := func(sources []string) []string {
		return slices.DeleteFunc(slices.Clone(sources), func(s string) bool { return s == path })
	}
	switch {
	case f.Move != nil:
		a := *f.Move
		a.Sources = without(a.Sources)
		return a.Form(), len(a.Sources)
	case f.Delete != nil:
		a := *f.Delete
		a.Sources = without(a.Sources)
		return a.Form(), len(a.Sources)
	case f.Purge != nil:
		a := *f.Purge
		a.Sources = without(a.Sources)
		return a.Form(), len(a.Sources)
	}
	return f, 0
}

// dropsMissing reports whether a run of the operation leaves out the sources that don't exist
// any more, instead of failing: a Move, Delete or Purge removes its own source.
func dropsMissing(operation operations.Operation) bool {
	return operation == operations.OperationMove || operation == operations.OperationDelete ||
		operation == operations.OperationPurge
}

// sameForm reports whether two forms run the same: the same operation with the same arguments.
// MarshalArgs writes struct fields in order and sorts map keys, so equal forms give equal bytes.
func sameForm(a, b operations.Form) bool {
	if a.Operation != b.Operation {
		return false
	}
	ra, errA := a.MarshalArgs()
	rb, errB := b.MarshalArgs()
	return errA == nil && errB == nil && bytes.Equal(ra, rb)
}

// firstSource returns the form's first source, or "".
func firstSource(f operations.Form) string {
	if sources, _ := f.Ends(); len(sources) > 0 {
		return sources[0]
	}
	return ""
}
