package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/templates"
)

// writeTransferFiles writes files under dir, by their slash-separated paths, with their
// contents.
func writeTransferFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func transferExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// awaitTransfer waits for a transfer to end, as an agent does, and returns it.
func awaitTransfer(t *testing.T, cs *mcp.ClientSession, id string) transferDetail {
	t.Helper()
	d := must[transferDetail](t, cs, "wait_for_transfer", map[string]any{"transfer_id": id, "timeout_seconds": 60})
	if d.StillRunning || d.EndedAt == "" {
		t.Fatalf("%s is still running after a minute: %+v", id, d.transferRow)
	}
	return d
}

func pathsOfTransferFiles(files []transferFile) []string {
	out := make([]string, len(files))
	for i, f := range files {
		out[i] = f.Path
	}
	return out
}

// A copy runs in the background as the agent's, and the agent follows it to its end and finds it
// in the list, by its id or its number.
func TestCopy(t *testing.T) {
	cs := connect(t)
	src, dst := filepath.Join(t.TempDir(), "Photos"), t.TempDir()
	writeTransferFiles(t, src, map[string]string{"a.jpg": "aaa", "trip/b.jpg": "bbbb"})

	started := must[transferStarted](t, cs, "copy", map[string]any{"sources": []string{"box:" + src}, "destination": dst})
	if started.TransferID == "" || started.Number <= 0 || started.IgnoredOptions == nil {
		t.Fatalf("copy: %+v", started)
	}
	d := awaitTransfer(t, cs, started.TransferID)
	if d.State != "completed" || d.Operation != "copy" || d.DryRun || d.Error != "" {
		t.Fatalf("the copy ended as %+v", d)
	}
	if d.StartedBy != (transferOrigin{Kind: "agent", Name: "Test Agent"}) {
		t.Errorf("started by %+v", d.StartedBy)
	}
	for _, name := range []string{"a.jpg", "trip/b.jpg"} {
		if !transferExists(filepath.Join(dst, "Photos", filepath.FromSlash(name))) {
			t.Errorf("%s was not copied into the destination under its folder's name", name)
		}
	}
	if d.Totals == nil || d.Totals.FilesTransferred != 2 || d.Totals.Bytes != 7 {
		t.Errorf("totals %+v", d.Totals)
	}
	if d.Changed.Count != 2 || d.Changed.ByAction["copy"] != 2 || len(d.Changed.Files) != 2 || d.Changed.Truncated {
		t.Errorf("changed %+v", d.Changed)
	}
	for _, f := range d.Changed.Files {
		if f.Action != "copy" || !strings.HasPrefix(f.Path, "box:") || !strings.HasSuffix(f.Path, ".jpg") || f.Size == 0 {
			t.Errorf("a copied file: %+v", f)
		}
	}

	// The number that History shows names the same transfer.
	byNumber := must[transferDetail](t, cs, "get_transfer", map[string]any{"transfer_id": fmt.Sprintf("#%d", started.Number)})
	if byNumber.TransferID != started.TransferID {
		t.Errorf("#%d is %s, want %s", started.Number, byNumber.TransferID, started.TransferID)
	}
	if _, failed := call[transferDetail](t, cs, "get_transfer", map[string]any{"transfer_id": "#999999999"}); !strings.Contains(failed, "No such transfer") {
		t.Errorf("an unknown number: %q", failed)
	}
	if _, failed := call[transferDetail](t, cs, "get_transfer", map[string]any{"transfer_id": "nope"}); failed == "" {
		t.Error("an unknown id was found")
	}

	list := must[transferList](t, cs, "list_transfers", map[string]any{"search": src})
	if len(list.Transfers) != 1 || list.Transfers[0].TransferID != started.TransferID || list.Truncated {
		t.Errorf("list_transfers: %+v", list)
	}
}

// An option that the operation doesn't take is left out and named, and an option's value that
// rclone can't read is refused.
func TestCopyOptions(t *testing.T) {
	cs := connect(t)
	src, dst := t.TempDir(), t.TempDir()
	writeTransferFiles(t, src, map[string]string{"keep.txt": "k", "skip.log": "s"})

	started := must[transferStarted](t, cs, "copy", map[string]any{
		"sources": []string{src}, "destination": dst,
		"options": map[string]any{"exclude": []string{"*.log"}, "no_such_option": true, "vfs_cache_mode": "full"},
	})
	var ignored []string
	for _, o := range started.IgnoredOptions {
		if o.Reason == "" {
			t.Errorf("%s is ignored without a reason", o.Option)
		}
		ignored = append(ignored, o.Option)
	}
	slices.Sort(ignored)
	if !slices.Equal(ignored, []string{"no_such_option", "vfs_cache_mode"}) {
		t.Errorf("ignored %+v", started.IgnoredOptions)
	}
	if d := awaitTransfer(t, cs, started.TransferID); d.State != "completed" {
		t.Fatalf("the copy ended as %+v", d)
	}
	folder := filepath.Join(dst, filepath.Base(src))
	if !transferExists(filepath.Join(folder, "keep.txt")) || transferExists(filepath.Join(folder, "skip.log")) {
		t.Error("the exclude option was not applied")
	}
	// A local file is named by its path, as the agent wrote the source.
	if d := must[transferDetail](t, cs, "get_transfer", map[string]any{"transfer_id": started.TransferID}); len(d.Changed.Files) != 1 ||
		d.Changed.Files[0].Path != filepath.Join(src, "keep.txt") {
		t.Errorf("the copied files: %+v", d.Changed.Files)
	}

	if _, failed := call[transferStarted](t, cs, "copy", map[string]any{
		"sources": []string{src}, "destination": dst, "options": map[string]any{"max_age": "banana"},
	}); failed == "" {
		t.Error("a max_age of banana was taken")
	}
	if _, failed := call[transferStarted](t, cs, "copy", map[string]any{
		"sources": []string{filepath.Join(src, "missing")}, "destination": dst,
	}); failed == "" {
		t.Error("a missing source was copied")
	}
	if _, failed := call[transferStarted](t, cs, "copy", map[string]any{"sources": []string{src}}); failed == "" {
		t.Error("a copy without a destination started")
	}
}

// A sync's dry run lists the copies and the deletions it would make, deletions first, and
// changes nothing. The real run then makes the destination match.
func TestSyncDryRunThenReal(t *testing.T) {
	cs := connect(t)
	src, dst := t.TempDir(), t.TempDir()
	writeTransferFiles(t, src, map[string]string{"new.txt": "new"})
	writeTransferFiles(t, dst, map[string]string{"old.txt": "old"})

	dry := must[transferStarted](t, cs, "sync", map[string]any{"source": src, "destination": "box:" + dst, "dry_run": true})
	d := awaitTransfer(t, cs, dry.TransferID)
	if d.State != "completed" || !d.DryRun {
		t.Fatalf("the dry run ended as %+v", d)
	}
	if !transferExists(filepath.Join(dst, "old.txt")) || transferExists(filepath.Join(dst, "new.txt")) {
		t.Fatal("the dry run changed the destination")
	}
	files := d.Changed.Files
	if len(files) != 2 || files[0].Action != "delete" || !strings.HasSuffix(files[0].Path, "old.txt") ||
		files[1].Action != "copy" || !strings.HasSuffix(files[1].Path, "new.txt") {
		t.Errorf("the dry run would change %+v", files)
	}
	if d.Changed.ByAction["delete"] != 1 || d.Changed.ByAction["copy"] != 1 {
		t.Errorf("by action %v", d.Changed.ByAction)
	}
	if d.Totals == nil || d.Totals.Deleted != 1 || d.Totals.FilesTransferred != 1 {
		t.Errorf("the dry run's totals %+v", d.Totals)
	}

	real := must[transferStarted](t, cs, "sync", map[string]any{"source": src, "destination": "box:" + dst})
	if d := awaitTransfer(t, cs, real.TransferID); d.State != "completed" || d.DryRun {
		t.Fatalf("the sync ended as %+v", d)
	}
	if transferExists(filepath.Join(dst, "old.txt")) || !transferExists(filepath.Join(dst, "new.txt")) {
		t.Error("the sync didn't make the destination match the source")
	}
}

func TestMove(t *testing.T) {
	cs := connect(t)
	src, dst := t.TempDir(), t.TempDir()
	writeTransferFiles(t, src, map[string]string{"box/f.txt": "f", "g.txt": "g"})

	started := must[transferStarted](t, cs, "move", map[string]any{
		"sources": []string{filepath.Join(src, "box"), filepath.Join(src, "g.txt")}, "destination": dst,
	})
	if d := awaitTransfer(t, cs, started.TransferID); d.State != "completed" || d.Operation != "move" {
		t.Fatalf("the move ended as %+v", d)
	}
	if !transferExists(filepath.Join(dst, "box", "f.txt")) || !transferExists(filepath.Join(dst, "g.txt")) {
		t.Error("the files are not in the destination")
	}
	if transferExists(filepath.Join(src, "box", "f.txt")) || transferExists(filepath.Join(src, "g.txt")) {
		t.Error("the files are still in the source")
	}
}

// The first bisync of two folders is refused with what to do instead, a resync sets the
// baseline, and later runs carry changes both ways.
func TestBisync(t *testing.T) {
	cs := connect(t)
	one, two := t.TempDir(), t.TempDir()
	writeTransferFiles(t, one, map[string]string{"one.txt": "1"})
	writeTransferFiles(t, two, map[string]string{"two.txt": "2"})
	args := map[string]any{"path1": one, "path2": "box:" + two}

	if _, failed := call[transferStarted](t, cs, "bisync", args); !strings.Contains(failed, "resync") {
		t.Fatalf("a first bisync: %q", failed)
	}
	dry := must[transferStarted](t, cs, "bisync", map[string]any{"path1": one, "path2": "box:" + two, "resync": true, "dry_run": true})
	if d := awaitTransfer(t, cs, dry.TransferID); d.State != "completed" || !d.DryRun {
		t.Fatalf("the resync's dry run ended as %+v", d)
	}
	if transferExists(filepath.Join(one, "two.txt")) || transferExists(filepath.Join(two, "one.txt")) {
		t.Fatal("the dry run copied files")
	}
	resync := must[transferStarted](t, cs, "bisync", map[string]any{"path1": one, "path2": "box:" + two, "resync": true})
	if d := awaitTransfer(t, cs, resync.TransferID); d.State != "completed" {
		t.Fatalf("the resync ended as %+v", d)
	}
	if !transferExists(filepath.Join(one, "two.txt")) || !transferExists(filepath.Join(two, "one.txt")) {
		t.Fatal("the resync didn't copy both ways")
	}

	writeTransferFiles(t, two, map[string]string{"later.txt": "later"})
	if err := os.Remove(filepath.Join(one, "one.txt")); err != nil {
		t.Fatal(err)
	}
	run := must[transferStarted](t, cs, "bisync", args)
	if d := awaitTransfer(t, cs, run.TransferID); d.State != "completed" {
		t.Fatalf("the bisync ended as %+v", d)
	}
	if !transferExists(filepath.Join(one, "later.txt")) || transferExists(filepath.Join(two, "one.txt")) {
		t.Error("the bisync didn't carry the new file and the deletion across")
	}
}

// A delete deletes the files that its filters keep and leaves the folders. A purge deletes whole
// folders. Neither takes a remote's root, and a purge takes no file.
func TestDeleteAndPurge(t *testing.T) {
	cs := connect(t)
	dir := t.TempDir()
	writeTransferFiles(t, dir, map[string]string{"a.txt": "a", "b.log": "b", "sub/c.log": "c"})
	args := map[string]any{"paths": []string{"box:" + dir}, "options": map[string]any{"include": []string{"*.log"}}}

	dry := must[transferStarted](t, cs, "delete", map[string]any{
		"paths": []string{"box:" + dir}, "options": map[string]any{"include": []string{"*.log"}}, "dry_run": true,
	})
	d := awaitTransfer(t, cs, dry.TransferID)
	got := pathsOfTransferFiles(d.Changed.Files)
	slices.Sort(got)
	if d.State != "completed" || !d.DryRun || !slices.Equal(got, []string{"b.log", "sub/c.log"}) || d.Changed.ByAction["delete"] != 2 {
		t.Fatalf("the dry run would delete %v: %+v", got, d)
	}
	if !transferExists(filepath.Join(dir, "b.log")) {
		t.Fatal("the dry run deleted a file")
	}
	real := must[transferStarted](t, cs, "delete", args)
	if d := awaitTransfer(t, cs, real.TransferID); d.State != "completed" {
		t.Fatalf("the delete ended as %+v", d)
	}
	if !transferExists(filepath.Join(dir, "a.txt")) || transferExists(filepath.Join(dir, "b.log")) ||
		transferExists(filepath.Join(dir, "sub", "c.log")) || !transferExists(filepath.Join(dir, "sub")) {
		t.Error("the delete didn't delete just the .log files, keeping the folders")
	}

	writeTransferFiles(t, dir, map[string]string{"gone/x.txt": "x", "gone/deep/y.txt": "y"})
	purged := must[transferStarted](t, cs, "purge", map[string]any{"paths": []string{filepath.Join(dir, "gone")}})
	if d := awaitTransfer(t, cs, purged.TransferID); d.State != "completed" || d.Operation != "purge" {
		t.Fatalf("the purge ended as %+v", d)
	}
	if transferExists(filepath.Join(dir, "gone")) || !transferExists(filepath.Join(dir, "a.txt")) {
		t.Error("the purge didn't delete just its folder")
	}

	// Refused before anything runs. The dry runs keep them harmless all the same.
	for _, c := range []struct{ tool, path string }{
		{"delete", "box:"}, {"purge", "box:"}, {"purge", filepath.Join(dir, "a.txt")}, {"purge", filepath.Join(dir, "missing")},
	} {
		if _, failed := call[transferStarted](t, cs, c.tool, map[string]any{"paths": []string{c.path}, "dry_run": true}); failed == "" {
			t.Errorf("%s of %s was taken", c.tool, c.path)
		}
	}
	if !transferExists(filepath.Join(dir, "a.txt")) {
		t.Error("a refused purge deleted a file")
	}
}

// A download saves a link's file under the link's name or the one given, and asks for a name
// when the link has none.
func TestDownload(t *testing.T) {
	cs := connect(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("report body"))
	}))
	t.Cleanup(srv.Close)
	dir := t.TempDir()

	started := must[transferStarted](t, cs, "download", map[string]any{"url": srv.URL + "/files/q3%20report.txt", "destination": dir})
	if d := awaitTransfer(t, cs, started.TransferID); d.State != "completed" || d.Operation != "download" {
		t.Fatalf("the download ended as %+v", d)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "q3 report.txt")); err != nil || string(b) != "report body" {
		t.Errorf("the downloaded file: %q, %v", b, err)
	}

	named := must[transferStarted](t, cs, "download", map[string]any{"url": srv.URL + "/", "destination": dir, "filename": "index.html"})
	if d := awaitTransfer(t, cs, named.TransferID); d.State != "completed" || !transferExists(filepath.Join(dir, "index.html")) {
		t.Fatalf("a named download ended as %+v", d)
	}
	if _, failed := call[transferStarted](t, cs, "download", map[string]any{"url": srv.URL + "/", "destination": dir}); !strings.Contains(failed, "filename") {
		t.Errorf("a link without a file name: %q", failed)
	}
}

// A running transfer shows its progress in the list. A wait that times out says so, a stop
// ends the transfer as stopped, and a transfer that isn't running can't be stopped.
func TestWaitAndStop(t *testing.T) {
	cs := connect(t)
	// The link sends a little of a large file, and then nothing until it is stopped.
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100000000")
		_, _ = w.Write(make([]byte, 1024))
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	t.Cleanup(func() { close(release); srv.Close() })
	dir := t.TempDir()

	started := must[transferStarted](t, cs, "download", map[string]any{"url": srv.URL + "/big.bin", "destination": dir})
	waited := must[transferDetail](t, cs, "wait_for_transfer", map[string]any{"transfer_id": started.TransferID, "timeout_seconds": 1})
	if !waited.StillRunning || waited.State != "running" || waited.EndedAt != "" {
		t.Fatalf("a wait that timed out: %+v", waited.transferRow)
	}
	running := must[transferList](t, cs, "list_transfers", map[string]any{"state": "running", "search": dir})
	if len(running.Transfers) != 1 || running.Transfers[0].TransferID != started.TransferID {
		t.Fatalf("the running transfers: %+v", running)
	}

	stopped := must[transferRow](t, cs, "stop_transfer", map[string]any{"transfer_id": started.TransferID})
	if stopped.State != "stopped" {
		t.Errorf("after a stop: %+v", stopped)
	}
	if d := awaitTransfer(t, cs, started.TransferID); d.State != "stopped" {
		t.Errorf("a stopped transfer ended as %+v", d)
	}
	if _, failed := call[transferRow](t, cs, "stop_transfer", map[string]any{"transfer_id": started.TransferID}); !strings.Contains(failed, "not running") {
		t.Errorf("a second stop: %q", failed)
	}
}

// A failed transfer's failures can be retried, and the retry is a new transfer that keeps the
// original's origin. A transfer with nothing that failed has nothing to retry.
func TestRetry(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("a file can't be made unreadable here")
	}
	cs := connect(t)
	src, dst := t.TempDir(), t.TempDir()
	writeTransferFiles(t, src, map[string]string{"ok.txt": "ok", "locked.txt": "locked"})
	locked := filepath.Join(src, "locked.txt")
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o644) })

	// The copy fails within the moment that a start waits for, so the start fails, and names the
	// transfer that it recorded.
	_, failed := call[transferStarted](t, cs, "copy", map[string]any{"sources": []string{src}, "destination": dst})
	list := must[transferList](t, cs, "list_transfers", map[string]any{"search": src, "state": "failed"})
	if len(list.Transfers) != 1 || !strings.Contains(failed, list.Transfers[0].TransferID) {
		t.Fatalf("the copy's start: %q, and the failed transfers %+v", failed, list)
	}
	started := list.Transfers[0]
	d := awaitTransfer(t, cs, started.TransferID)
	if d.State != "failed" || d.Failed.Count != 1 || len(d.Failed.Files) != 1 ||
		!strings.HasSuffix(d.Failed.Files[0].Path, "locked.txt") || d.Failed.Files[0].Error == "" || d.RetryableParts == 0 {
		t.Fatalf("the copy ended as %+v", d)
	}
	if err := os.Chmod(locked, 0o644); err != nil {
		t.Fatal(err)
	}
	retry := must[transferStarted](t, cs, "retry_transfer", map[string]any{"transfer_id": fmt.Sprintf("#%d", started.Number)})
	r := awaitTransfer(t, cs, retry.TransferID)
	if r.State != "completed" || r.RetryOf != started.Number || r.StartedBy.Kind != "agent" {
		t.Fatalf("the retry ended as %+v", r)
	}
	if !transferExists(filepath.Join(dst, filepath.Base(src), "locked.txt")) {
		t.Error("the retry didn't copy the file")
	}
	if _, failed := call[transferStarted](t, cs, "retry_transfer", map[string]any{"transfer_id": retry.TransferID}); failed == "" {
		t.Error("a transfer with nothing that failed was retried")
	}
}

// The list puts the newest first, and is capped. Its state must be one that it knows.
func TestListTransfers(t *testing.T) {
	cs := connect(t)
	src := t.TempDir()
	writeTransferFiles(t, src, map[string]string{"f.txt": "f"})
	var numbers []int64
	for range 3 {
		started := must[transferStarted](t, cs, "copy", map[string]any{"sources": []string{filepath.Join(src, "f.txt")}, "destination": t.TempDir()})
		awaitTransfer(t, cs, started.TransferID)
		numbers = append(numbers, started.Number)
	}

	all := must[transferList](t, cs, "list_transfers", map[string]any{"search": src, "limit": 10})
	if len(all.Transfers) != 3 || all.Truncated {
		t.Fatalf("all: %+v", all)
	}
	for i, row := range all.Transfers {
		if row.Number != numbers[2-i] || row.State != "completed" || row.StartedAt == "" || row.EndedAt == "" || row.Progress != nil {
			t.Errorf("row %d: %+v", i, row)
		}
	}
	capped := must[transferList](t, cs, "list_transfers", map[string]any{"search": src, "limit": 2})
	if len(capped.Transfers) != 2 || !capped.Truncated || capped.More == "" || capped.Transfers[0].Number != numbers[2] {
		t.Errorf("capped: %+v", capped)
	}
	if finished := must[transferList](t, cs, "list_transfers", map[string]any{"search": src, "state": "finished"}); len(finished.Transfers) != 3 {
		t.Errorf("finished: %+v", finished)
	}
	if failed := must[transferList](t, cs, "list_transfers", map[string]any{"search": src, "state": "failed"}); len(failed.Transfers) != 0 {
		t.Errorf("failed: %+v", failed)
	}
	if _, failed := call[transferList](t, cs, "list_transfers", map[string]any{"state": "sleeping"}); failed == "" {
		t.Error("an unknown state was taken")
	}
}

// get_transfer caps the changed files and puts the deletions first, and the count still says
// how many there are.
func TestChangedFilesAreCapped(t *testing.T) {
	cs := connect(t)
	src, dst := t.TempDir(), t.TempDir()
	files := map[string]string{}
	for i := range transferChangedShown + 20 {
		files[fmt.Sprintf("f%03d.txt", i)] = "x"
	}
	writeTransferFiles(t, src, files)
	writeTransferFiles(t, dst, map[string]string{"zzz-extra.txt": "old"})

	dry := must[transferStarted](t, cs, "sync", map[string]any{"source": src, "destination": dst, "dry_run": true})
	d := awaitTransfer(t, cs, dry.TransferID)
	c := d.Changed
	if c.Count != transferChangedShown+21 || len(c.Files) != transferChangedShown || !c.Truncated ||
		c.ByAction["copy"] != transferChangedShown+20 || c.ByAction["delete"] != 1 {
		t.Fatalf("changed: count %d, %d files, truncated %v, %v", c.Count, len(c.Files), c.Truncated, c.ByAction)
	}
	if c.Files[0].Action != "delete" || c.Files[0].Path != "zzz-extra.txt" {
		t.Errorf("the deletion is not first: %+v", c.Files[0])
	}
}

// The user's templates are listed with the operations that they run as, and run, for real or
// as a dry run. A template runs only as an operation that it has paths for.
func TestTemplates(t *testing.T) {
	cs := connect(t)
	src, dst := t.TempDir(), t.TempDir()
	writeTransferFiles(t, src, map[string]string{"a.txt": "a", "b.log": "b"})
	ctx := context.Background()
	saved, err := apis.Templates.Save(ctx, templates.Template{
		Name: "Backup " + filepath.Base(src),
		Tags: []operations.Operation{operations.OperationCopy, operations.OperationMount},
		Options: catalog.Group{
			"exclude":        json.RawMessage(`["*.log"]`),
			"vfs_cache_mode": json.RawMessage(`"full"`),
		},
		Paths: &templates.Paths{Sources: []string{src}, Destination: dst},
	})
	if err != nil {
		t.Fatal(err)
	}
	bare, err := apis.Templates.Save(ctx, templates.Template{Name: "Options only", Tags: []operations.Operation{operations.OperationSync}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = apis.Templates.DeleteMany(ctx, []string{saved.ID, bare.ID}) })

	list := must[transferTemplates](t, cs, "list_templates", nil)
	byID := map[string]transferTemplate{}
	for _, tpl := range list.Templates {
		byID[tpl.TemplateID] = tpl
	}
	if got := byID[saved.ID]; got.Name != saved.Name || !slices.Equal(got.Operations, []string{"copy", "mount"}) ||
		!slices.Equal(got.CanRunAs, []string{"copy"}) || !slices.Equal(got.Sources, []string{src}) || got.Destination != dst {
		t.Errorf("the template: %+v", got)
	}
	if got := byID[bare.ID]; len(got.CanRunAs) != 0 || got.Sources != nil {
		t.Errorf("a template without paths: %+v", got)
	}

	dry := must[transferStarted](t, cs, "run_template", map[string]any{"template_id": saved.ID, "operation": "copy", "dry_run": true})
	if len(dry.IgnoredOptions) != 1 || dry.IgnoredOptions[0].Option != "vfs_cache_mode" {
		t.Errorf("ignored %+v", dry.IgnoredOptions)
	}
	if d := awaitTransfer(t, cs, dry.TransferID); d.State != "completed" || !d.DryRun || d.Changed.Count != 1 {
		t.Fatalf("the dry run ended as %+v", d)
	}
	if transferExists(filepath.Join(dst, filepath.Base(src))) {
		t.Fatal("the dry run copied files")
	}
	run := must[transferStarted](t, cs, "run_template", map[string]any{"template_id": saved.ID, "operation": "copy"})
	d := awaitTransfer(t, cs, run.TransferID)
	if d.State != "completed" || d.StartedBy != (transferOrigin{Kind: "template", Name: saved.Name}) {
		t.Fatalf("the run ended as %+v", d)
	}
	if !transferExists(filepath.Join(dst, filepath.Base(src), "a.txt")) || transferExists(filepath.Join(dst, filepath.Base(src), "b.log")) {
		t.Error("the template's paths or options were not applied")
	}

	for _, c := range []struct{ id, op string }{{saved.ID, "mount"}, {saved.ID, "sync"}, {bare.ID, "sync"}, {"nope", "copy"}} {
		if _, failed := call[transferStarted](t, cs, "run_template", map[string]any{"template_id": c.id, "operation": c.op, "dry_run": true}); failed == "" {
			t.Errorf("%s ran as %s", c.id, c.op)
		}
	}
}

func TestLinkFilename(t *testing.T) {
	for link, want := range map[string]string{
		"https://example.com/a/report.pdf":   "report.pdf",
		"https://example.com/q3%20plan.txt":  "q3 plan.txt",
		"https://example.com/a%2Fb":          "a%2Fb",
		"https://example.com/":               "",
		"https://example.com":                "",
		"https://example.com/file.zip?x=1#y": "file.zip",
	} {
		if got := linkFilename(link); got != want {
			t.Errorf("%s: %q, want %q", link, got, want)
		}
	}
}
