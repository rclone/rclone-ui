package schedules

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/operations"
)

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

func LeftOff(f operations.Form) ([]string, error) {
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

func on(v json.RawMessage) bool {
	var b bool
	if json.Unmarshal(v, &b) == nil {
		return b
	}
	var s string
	return json.Unmarshal(v, &s) == nil && strings.EqualFold(s, "true")
}

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

func dropsMissing(operation operations.Operation) bool {
	return operation == operations.OperationMove || operation == operations.OperationDelete ||
		operation == operations.OperationPurge
}

func sameForm(a, b operations.Form) bool {
	if a.Operation != b.Operation {
		return false
	}
	ra, errA := a.MarshalArgs()
	rb, errB := b.MarshalArgs()
	return errA == nil && errB == nil && bytes.Equal(ra, rb)
}

func firstSource(f operations.Form) string {
	if sources, _ := f.Ends(); len(sources) > 0 {
		return sources[0]
	}
	return ""
}
