package operations

import (
	"encoding/json"
	"testing"
)

// Each operation's arguments come back from MarshalArgs through DecodeForm as they were, and
// MarshalArgs writes the same JSON again.
func TestFormRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		op   Operation
		args string
	}{
		{OperationCopy, `{"sources":["a:x","b:y"],"destination":"c:","options":{"filter":{"exclude":["*.tmp"]},"config":{"transfers":4}}}`},
		{OperationMove, `{"sources":["a:x"],"destination":"c:","options":{"move":{"delete_empty_src_dirs":true}}}`},
		{OperationSync, `{"source":"a:x","destination":"c:z","options":{"sync":{"track_renames":true},"remotes":{"a":{"chunk_size":"64M"}}}}`},
		{OperationBisync, `{"source":"a:x","destination":"c:z","options":{"outer":{"dryRun":true,"maxDelete":10,"resync":true,"backupDir1":"a:old","conflictResolve":"newer"}}}`},
		{OperationDelete, `{"sources":["a:x"],"options":{"metadata":{"metadata":true}}}`},
		{OperationPurge, `{"sources":["a:x"],"options":{"config":{"dry_run":true}}}`},
		{OperationDownload, `{"url":"https://e/x.zip","filename":"x.zip","destination":"gdrive:dl","options":{"config":{"multi_thread_streams":4}}}`},
		{OperationSave, `{"source":"a:f.txt","destination":"/srv/f.txt"}`},
		{OperationRename, `{"items":[{"path":"a:d/old","isDir":true,"newName":"new"}]}`},
		{OperationDeleteFolder, `{"path":"/srv/old"}`},
		{OperationCleanup, `{"remote":"gdrive:"}`},
		{OperationMount, `{"source":"a:x","destination":"/mnt/x","options":{"mount":{"allow_other":true},"vfs":{"vfs_cache_mode":"full"}}}`},
		{OperationServe, `{"type":"http","source":"a:x","addr":"127.0.0.1:0","options":{"serve":{"user":"me"}}}`},
	} {
		f, err := DecodeForm(tc.op, json.RawMessage(tc.args))
		if err != nil {
			t.Errorf("%s: %v", tc.op, err)
			continue
		}
		if f.Operation != tc.op || f.Check() != nil {
			t.Errorf("%s: decoded as %s (%v)", tc.op, f.Operation, f.Check())
		}
		raw, err := f.MarshalArgs()
		if err != nil || string(raw) != tc.args {
			t.Errorf("%s: %s (%v), want %s", tc.op, raw, err, tc.args)
		}
		// The form itself, as the pages send it, decodes to the same form.
		whole, err := json.Marshal(f)
		if err != nil {
			t.Fatal(err)
		}
		var back Form
		if err := json.Unmarshal(whole, &back); err != nil {
			t.Fatal(err)
		}
		if again, _ := back.MarshalArgs(); string(again) != tc.args {
			t.Errorf("%s: %s after the whole form's JSON", tc.op, again)
		}
	}
}

// A number keeps the digits that the page wrote, such as the zero of 1.50, all the way to the
// stored arguments.
func TestFormKeepsNumbers(t *testing.T) {
	args := `{"sources":["a:x"],"destination":"c:","options":{"config":{"max_backlog":1.50,"retries_sleep":1e3}}}`
	f, err := DecodeForm(OperationCopy, json.RawMessage(args))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(f.Copy.Options.Config["max_backlog"]); got != "1.50" {
		t.Fatalf("decoded as %s", got)
	}
	raw, err := f.MarshalArgs()
	if err != nil || string(raw) != args {
		t.Fatalf("%s (%v)", raw, err)
	}
}

// A field that the operation's arguments don't have is refused, and so is a switch that bisync
// doesn't have.
func TestDecodeFormRefusesUnknownFields(t *testing.T) {
	for _, tc := range []struct {
		op   Operation
		args string
	}{
		{OperationCopy, `{"source":"a:x","destination":"c:"}`},
		{OperationSync, `{"source":"a:x","options":{"downloads":{}}}`},
		{OperationBisync, `{"source":"a:x","options":{"outer":{"bogus":true}}}`},
		{OperationCleanup, `{"remote":"a:","path":"x"}`},
		{OperationCopy, `{"options":{"config":[1]}}`},
		{"format", `{}`},
	} {
		if f, err := DecodeForm(tc.op, json.RawMessage(tc.args)); err == nil {
			t.Errorf("%s %s: decoded as %+v", tc.op, tc.args, f)
		}
	}
	if f, err := DecodeForm(OperationCopy, nil); err != nil || f.Copy == nil {
		t.Errorf("no arguments: %+v %v", f, err)
	}
}

// A form holds only its own operation's arguments, whose JSON names the form's fields follow.
func TestFormRefusesAnotherOperationsField(t *testing.T) {
	for name, f := range map[string]Form{
		"a sync's field":  {Operation: OperationCopy, Sync: &SyncArgs{Source: "a:x"}},
		"two fields":      {Operation: OperationCopy, Copy: &CopyArgs{}, Move: &MoveArgs{}},
		"an unknown one":  {Operation: "format"},
		"a field without": {Copy: &CopyArgs{}},
	} {
		if err := f.Check(); err == nil {
			t.Errorf("%s: accepted", name)
		}
		if _, err := f.MarshalArgs(); err == nil {
			t.Errorf("%s: marshalled", name)
		}
	}
	// Without its field, a form has empty arguments.
	if raw, err := (Form{Operation: OperationDelete}).MarshalArgs(); err != nil || string(raw) != `{}` {
		t.Errorf("an empty delete: %s %v", raw, err)
	}
	if err := (Form{Operation: OperationCopy, Copy: &CopyArgs{}}).Check(); err != nil {
		t.Error(err)
	}
}

// Groups returns the arguments' own groups, so a change through it changes the form.
func TestFormGroups(t *testing.T) {
	f := CopyArgs{Options: groups("config", `{"dry_run": true}`)}.Form()
	delete(f.Groups().Config, "dry_run")
	if len(f.Copy.Options.Config) != 0 {
		t.Fatalf("config %s", f.Copy.Options.Config)
	}
	folder := FolderArgs{Path: "a:x"}.Form()
	if folder.Groups() != nil || (&Form{Operation: OperationCopy}).Groups() != nil {
		t.Fatal("groups of a form without any")
	}
	var none *Form
	if none.Groups() != nil {
		t.Fatal("groups of no form")
	}
}

// A rename rewrites the form's paths, the option values that name a path on the remote, the keys
// of the remotes group and bisync's outer backup folders, and says whether the paths changed.
func TestFormRenameRemote(t *testing.T) {
	f, err := DecodeForm(OperationBisync, json.RawMessage(`{"source":"old:a","destination":"/b","options":{
		"sync":{"backup_dir":"old:trash"},"remotes":{"old":{"chunk_size":"64M"}},
		"outer":{"backupDir1":"old:one","backupDir2":"other:two"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if changed, paths := f.RenameRemote("old", "new"); !changed || !paths {
		t.Errorf("changed %v, paths %v", changed, paths)
	}
	raw, err := f.MarshalArgs()
	if err != nil {
		t.Fatal(err)
	}
	want := `{"source":"new:a","destination":"/b","options":{"sync":{"backup_dir":"new:trash"},` +
		`"outer":{"backupDir1":"new:one","backupDir2":"other:two"},"remotes":{"new":{"chunk_size":"64M"}}}}`
	if string(raw) != want {
		t.Errorf("got %s", raw)
	}
	// Only an option names the remote: the paths stay.
	f = DeleteArgs{Sources: []string{"/a"}, Options: Groups{Outer: &BisyncSwitches{BackupDir2: "old:x"}}}.Form()
	if changed, paths := f.RenameRemote("old", "new"); !changed || paths || f.Delete.Options.Outer.BackupDir2 != "new:x" {
		t.Errorf("changed %v, paths %v, %+v", changed, paths, f.Delete.Options.Outer)
	}
	// A form of another remote doesn't change.
	f = FolderArgs{Path: "older:x"}.Form()
	if changed, _ := f.RenameRemote("old", "new"); changed || f.DeleteFolder.Path != "older:x" {
		t.Errorf("rewrote %s", f.DeleteFolder.Path)
	}
}
