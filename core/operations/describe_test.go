package operations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/cache"
	rcops "github.com/rclone/rclone/fs/operations"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// localTree creates a temp folder that holds a folder and a file.
func localTree(t *testing.T) (dir, folder, file string) {
	t.Helper()
	dir = filepath.ToSlash(t.TempDir())
	folder, file = dir+"/photos", dir+"/one.txt"
	if err := os.Mkdir(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, folder, file
}

func TestDescribeSources(t *testing.T) {
	dir, folder, file := localTree(t)
	remotes := remoteOverrides{":local": {"copy_links": true}}
	for _, config := range []Options{nil, {"transfers": "2"}} {
		kinds, err := describeSources(context.Background(), []string{folder, folder + "/", file, file, dir, ""},
			settings{config: config, remotes: remotes})
		if err != nil {
			t.Fatal(err)
		}
		want := Kinds{folder: KindFolder, folder + "/": KindFolder, file: KindFile, dir: KindFolder}
		if len(kinds) != len(want) {
			t.Fatalf("kinds %v", kinds)
		}
		for p, k := range want {
			if kinds[p] != k {
				t.Fatalf("%s is %s, want %s", p, kinds[p], k)
			}
		}
	}
	_, err := describeSources(context.Background(), []string{dir + "/missing"}, settings{})
	if err == nil || err.Error() != "Source does not exist, "+dir+"/missing is missing" {
		t.Fatalf("missing: %v", err)
	}
	var missing *SourceMissingError
	if !errors.As(err, &missing) || missing.Path != dir+"/missing" || !errs.Is(err) {
		t.Fatalf("missing: %#v is not a refusal that names the source", err)
	}
	if _, err := describeSources(context.Background(), []string{"-bad:x"}, settings{}); err == nil {
		t.Fatal("a path rclone refuses was asked about")
	}
	if _, err := describeSources(context.Background(), []string{dir}, settings{config: Options{"transfers": "many"}}); err == nil ||
		!strings.Contains(err.Error(), "transfers") {
		t.Fatalf("a bad option: %v", err)
	}
}

// A root is a folder, checked by reading its first page. It is accepted when it lists, and
// refused with rclone's error when it doesn't (an unplugged disk, a missing bucket).
func TestDescribeRoots(t *testing.T) {
	ctx := context.Background()
	_, err := rclone.Run(ctx, rclone.CallOpts{}, func(ctx context.Context) error {
		f, err := cache.Get(ctx, "mem:roots")
		if err != nil {
			return err
		}
		_, err = rcops.Rcat(ctx, f, "x.txt", io.NopCloser(strings.NewReader("x")), time.Now(), nil)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	gone := filepath.ToSlash(filepath.Join(t.TempDir(), "gone"))
	kinds, err := describeSources(ctx, []string{"mem:"}, settings{})
	if err != nil || kinds["mem:"] != KindFolder {
		t.Errorf("mem: is %v %v, want a folder", kinds, err)
	}
	unplugged := ":alias,remote='" + gone + "':"
	if _, err := describeSources(ctx, []string{unplugged}, settings{}); err == nil || !strings.Contains(err.Error(), "directory not found") {
		t.Errorf("%s: %v, want rclone's directory not found", unplugged, err)
	}
}

func TestBuildPlan(t *testing.T) {
	dir, folder, file := localTree(t)
	ctx := context.Background()
	// rclone's answer decides the step, however the path is written. The app's own mapper, typed
	// as one text with a quoted part, is stored as the list that the mapping panel writes.
	form := CopyArgs{Sources: []string{folder, file}, Destination: dir + "/out",
		Options: groups("metadata", `{"metadata": true, "metadata_mapper": "metadata-map --drop \"a b\""}`)}.Form()
	p, err := BuildPlan(ctx, form)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Steps) != 2 || p.Steps[0].Op != OpCopy || p.Steps[1].Op != OpCopyFile {
		t.Fatalf("plan %+v", p)
	}
	if got := p.Config["metadata_mapper"]; !slices.Equal(anyTexts(got), []string{"metadata-map", "--drop", "a b"}) {
		t.Fatalf("the mapper is stored as %v", got)
	}
	if string(form.Copy.Options.Metadata["metadata_mapper"]) != `"metadata-map --drop \"a b\""` {
		t.Fatal("building the plan changed the form")
	}
	if p, err = BuildPlan(ctx, PurgeArgs{Sources: []string{folder}}.Form()); err != nil || p.Steps[0].SrcRemote == "" {
		t.Fatalf("purge %+v %v", p, err)
	}
	if _, err := BuildPlan(ctx, SyncArgs{Source: file, Destination: dir + "/out"}.Form()); err == nil ||
		err.Error() != file+" is a file; a sync needs a folder" {
		t.Fatalf("sync of a file: %v", err)
	}
	if _, err := BuildPlan(ctx, DeleteArgs{Sources: []string{dir + "/gone"}}.Form()); err == nil ||
		!strings.Contains(err.Error(), "Source does not exist") {
		t.Fatalf("missing: %v", err)
	}
	if _, err := BuildPlan(ctx, SyncArgs{Destination: dir}.Form()); err == nil || err.Error() != "Please select a source path" {
		t.Fatalf("no source: %v", err)
	}
	for _, f := range []Form{
		RenameArgs{Items: []RenameItem{{Path: file, NewName: "two.txt"}}}.Form(),
		FolderArgs{Path: folder}.Form(),
		SaveArgs{Source: folder, Destination: dir + "/saved"}.Form(),
		DownloadArgs{URL: "https://example.com/x", Filename: "x", Destination: dir}.Form(),
		BisyncArgs{Source: folder, Destination: dir + "/b", Options: groups("outer", `{"resync": true}`)}.Form(),
		MoveArgs{Sources: []string{file}, Destination: dir + "/m/"}.Form(),
		CleanupArgs{Remote: dir}.Form(),
	} {
		if p, err := BuildPlan(ctx, f); err != nil || p.Check() != nil {
			t.Errorf("%s: %+v %v %v", f.Operation, p, err, p.Check())
		}
	}

	// Refused with rclone's error before rclone is asked anything.
	if _, err := BuildPlan(ctx, CopyArgs{Sources: []string{"-bad:x"}, Destination: dir}.Form()); err == nil ||
		!strings.HasPrefix(err.Error(), "Rclone cannot read this path: config name contains invalid characters") ||
		!errs.Is(err) {
		t.Fatalf("a bad path: %v", err)
	}
	if _, err := BuildPlan(ctx, CopyArgs{Sources: []string{dir + "/gone"}, Destination: dir,
		Options: groups("remotes", `{":local": {"copy_linkz": true}}`)}.Form()); err == nil ||
		err.Error() != "‘copy_linkz’ is not an option of :local (a local remote)" {
		t.Fatalf("an unknown override before the stat: %v", err)
	}
	if _, err := BuildPlan(ctx, CopyArgs{Sources: []string{dir + "/gone"}, Destination: dir,
		Options: groups("config", `{"no_such_option": 1}`)}.Form()); err == nil || !strings.Contains(err.Error(), "no_such_option") {
		t.Fatalf("an unknown option before the stat: %v", err)
	}
	if _, err := BuildPlan(ctx, Form{Operation: "format"}); err == nil {
		t.Fatal("an unknown operation was built")
	}
	if _, err := BuildPlan(ctx, MountArgs{Source: folder, Destination: dir}.Form()); err == nil {
		t.Fatal("a mount was built as a transfer")
	}
	if _, err := BuildPlan(ctx, Form{Operation: OperationCopy, Sync: &SyncArgs{Source: folder}}); err == nil {
		t.Fatal("a copy with a sync's arguments was built")
	}
	if RecordedOperation(OperationRename) != "move" || RecordedOperation(OperationDeleteFolder) != "purge" ||
		RecordedOperation(OperationSave) != "download" || RecordedOperation("copy") != "copy" {
		t.Fatal("recorded operations")
	}
}

// testExe is the running executable that the tests pretend to be.
var testExe = filepath.FromSlash("/opt/rcui/rcui")

// groups builds option groups as a page sends them, from pairs of name and JSON.
func groups(kv ...string) Groups {
	var b strings.Builder
	b.WriteByte('{')
	for i := 0; i+1 < len(kv); i += 2 {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%q:%s", kv[i], kv[i+1])
	}
	b.WriteByte('}')
	var g Groups
	if err := json.Unmarshal([]byte(b.String()), &g); err != nil {
		panic(fmt.Sprintf("groups %s: %v", b.String(), err))
	}
	return g
}

// decodeOptions decodes the JSON of one option group, as decodeGroup decodes a group.
func decodeOptions(raw json.RawMessage) (options, error) {
	var g catalog.Group
	if err := json.Unmarshal(raw, &g); err != nil {
		return nil, err
	}
	return decodeGroup(GroupConfig, g)
}

// anyTexts returns the texts of a stored list option.
func anyTexts(v any) []string {
	list, _ := v.([]any)
	out := make([]string, len(list))
	for i, e := range list {
		out[i], _ = e.(string)
	}
	return out
}
