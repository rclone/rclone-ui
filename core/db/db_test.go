package db

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"flag"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/rclone/rclone-ui/core/internal/testutil"
)

var update = flag.Bool("update", false, "rewrite testdata/schema/app.sql")

// TestSchemaGolden checks the schema that a fresh file gets. An edit to a schema file changes it,
// so run `go test ./core/db -update` and commit the golden file with the edit.
func TestSchemaGolden(t *testing.T) {
	d := openT(t, filepath.Join(t.TempDir(), "app.db"))
	got := schemaOf(t, d.W)
	golden := filepath.Join("testdata", "schema", "app.sql")
	if *update {
		testutil.Must(t, os.MkdirAll(filepath.Dir(golden), 0o755))
		testutil.Must(t, os.WriteFile(golden, []byte(got), 0o644))
	}
	want, err := os.ReadFile(golden)
	testutil.Must(t, err)
	if got != string(want) {
		t.Fatalf("schema differs from %s (a schema file added, missing or edited? go test ./core/db -update); got:\n%s", golden, got)
	}
}

func TestReopenKeepsTheSchemaAndReadersAreQueryOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	d := openT(t, path)
	testutil.Must(t, d.Write(ctx(t), func(tx *sql.Tx) error { return SetMeta(ctx(t), tx, "k", "v") }))
	errBoom := errors.New("boom")
	if err := d.Write(ctx(t), func(tx *sql.Tx) error {
		if err := SetMeta(ctx(t), tx, "k2", "v"); err != nil {
			return err
		}
		return errBoom
	}); !errors.Is(err, errBoom) {
		t.Fatalf("Write = %v", err)
	}
	testutil.Must(t, d.Close())

	d = openT(t, path)
	s, err := embeddedSchema()
	testutil.Must(t, err)
	if v, ok, err := d.GetMeta(ctx(t), schemaKey); err != nil || !ok || v != s.hash {
		t.Fatalf("meta.schema = %q, %v, %v", v, ok, err)
	}
	if v, ok, err := d.GetMeta(ctx(t), "k"); err != nil || !ok || v != "v" {
		t.Fatalf("GetMeta(k) = %q, %v, %v", v, ok, err)
	}
	if _, ok, err := d.GetMeta(ctx(t), "k2"); err != nil || ok {
		t.Fatalf("the rolled-back key: %v, %v", ok, err)
	}
	testutil.Must(t, d.Write(ctx(t), func(tx *sql.Tx) error { return SetMeta(ctx(t), tx, "k", "w") }))
	if v, _, _ := d.GetMeta(ctx(t), "k"); v != "w" {
		t.Fatalf("SetMeta again: %q", v)
	}
	if _, err := d.R.Exec(`DELETE FROM meta`); err == nil {
		t.Fatal("a reader wrote")
	}
	info, err := os.Stat(path)
	testutil.Must(t, err)
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
	// They are private whatever the process umask is, because SQLite gives -wal and -shm the
	// same mode as the database file.
	for _, suffix := range []string{"-wal", "-shm"} {
		info, err := os.Stat(path + suffix)
		testutil.Must(t, err)
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode %v", suffix, info.Mode().Perm())
		}
	}
}

func TestPathsThatNeedEscaping(t *testing.T) {
	name := "a b?c#d%e"
	if runtime.GOOS == "windows" {
		name = "a b#c%d" // Windows refuses '?' in a file name
	}
	path := filepath.Join(t.TempDir(), name, "app.db")
	testutil.Must(t, os.MkdirAll(filepath.Dir(path), 0o700))
	d := openT(t, path)
	testutil.Must(t, d.Close())
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

// testSchema is the base schema file and the extra files, read the way the embedded folder is.
func testSchema(t *testing.T, extra map[string]string) schema {
	t.Helper()
	base, err := fs.ReadFile(embedded, "migrations/0001_base.sql")
	testutil.Must(t, err)
	fsys := fstest.MapFS{"README.md": {Data: []byte("#")}, "0001_base.sql": {Data: base}}
	for name, sql := range extra {
		fsys[name] = &fstest.MapFile{Data: []byte(sql)}
	}
	s, err := loadSchema(fsys)
	testutil.Must(t, err)
	return s
}

func TestSchemaFileNames(t *testing.T) {
	s, err := embeddedSchema()
	testutil.Must(t, err)
	if len(s.files) == 0 || s.files[0].name != "0001_base.sql" {
		t.Fatalf("files %v", s.files)
	}
	// The README is in the same folder as the schema files and is skipped. A .sql file with a
	// name in the wrong form is refused.
	for name, ok := range map[string]bool{"0001_base.sql": true, "0002_Bad-Name.sql": false, "2_short.sql": false} {
		fsys := fstest.MapFS{"README.md": {Data: []byte("#")}, name: {Data: []byte("SELECT 1")}}
		if _, err := loadSchema(fsys); (err == nil) != ok {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := loadSchema(fstest.MapFS{"README.md": {Data: []byte("#")}}); err == nil {
		t.Error("a folder without schema files was taken")
	}
}

// The hash ignores comments and runs of whitespace, and notices any other edit, a rename and a
// new file.
func TestSchemaHash(t *testing.T) {
	plain := testSchema(t, map[string]string{"0002_x.sql": "CREATE TABLE x (a TEXT, b TEXT DEFAULT '--');"})
	same := testSchema(t, map[string]string{"0002_x.sql": "-- a comment\nCREATE TABLE x (a TEXT, -- why a\n  b  TEXT DEFAULT '--');\n"})
	if plain.hash != same.hash {
		t.Fatal("a comment or the whitespace changed the hash")
	}
	for name, other := range map[string]schema{
		"an edit":    testSchema(t, map[string]string{"0002_x.sql": "CREATE TABLE x (a TEXT, b TEXT DEFAULT '-');"}),
		"a rename":   testSchema(t, map[string]string{"0002_y.sql": "CREATE TABLE x (a TEXT, b TEXT DEFAULT '--');"}),
		"a new file": testSchema(t, map[string]string{"0002_x.sql": "CREATE TABLE x (a TEXT, b TEXT DEFAULT '--');", "0003_z.sql": "CREATE TABLE z (a)"}),
	} {
		if other.hash == plain.hash {
			t.Errorf("%s kept the hash", name)
		}
	}
}

func TestChangedSchemaIsRefusedAndTheFileUnchanged(t *testing.T) {
	for _, c := range []struct {
		name string
		make func(t *testing.T, path string)
	}{
		{"a schema file edited in place", func(t *testing.T, path string) {
			d, err := open(ctx(t), path, options{schema: testSchema(t, map[string]string{"0002_x.sql": "CREATE TABLE x (a)"})})
			testutil.Must(t, err)
			testutil.Must(t, d.Close())
		}},
		{"no meta.schema", func(t *testing.T, path string) {
			d := openT(t, path)
			_, err := d.W.Exec(`DELETE FROM meta WHERE key = ?`, schemaKey)
			testutil.Must(t, err)
			testutil.Must(t, d.Close())
		}},
		{"another app's file, without a meta table", func(t *testing.T, path string) {
			// In WAL mode, as the files that Open makes are, so that only the check could
			// change the file.
			c, err := sql.Open("sqlite", fileURI(path)+"?_pragma=journal_mode(WAL)")
			testutil.Must(t, err)
			_, err = c.Exec(`CREATE TABLE notes (body TEXT)`)
			testutil.Must(t, err)
			testutil.Must(t, c.Close())
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "app.db")
			c.make(t, path)
			before := fileSum(t, path)

			_, err := Open(ctx(t), path)
			if !errors.Is(err, ErrSchemaChanged) {
				t.Fatalf("Open = %v, want ErrSchemaChanged", err)
			}
			want := path + " was made with a different schema. Rclone UI 4 isn't released, so its database isn't migrated. Quit, delete the data folder " + dir + ", and start again."
			if err.Error() != want {
				t.Fatalf("message:\n%s\nwant:\n%s", err, want)
			}
			if fileSum(t, path) != before {
				t.Fatal("the file changed")
			}
		})
	}
}

func TestFailingSchemaFileLeavesNoTables(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	failing := testSchema(t, map[string]string{"0002_fails.sql": "CREATE TABLE half (x);\nINSERT INTO nowhere VALUES (1);"})
	_, err := open(ctx(t), path, options{schema: failing})
	if err == nil || errors.Is(err, ErrSchemaChanged) ||
		!strings.Contains(err.Error(), "schema file 0002_fails.sql failed") || !strings.Contains(err.Error(), "no such table: nowhere") {
		t.Fatalf("open = %v", err)
	}
	c, err := sql.Open("sqlite", fileURI(path))
	testutil.Must(t, err)
	var objects int
	testutil.Must(t, c.QueryRow(`SELECT count(*) FROM sqlite_schema`).Scan(&objects))
	testutil.Must(t, c.Close())
	if objects != 0 {
		t.Fatalf("%d tables or indexes were kept", objects)
	}
	// The file is still empty, so this build's schema is applied to it.
	openT(t, path)
}

func TestNonWALJournalIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix-dotfile is a Unix VFS")
	}
	// The unix-dotfile VFS has no shared memory, so SQLite keeps the rollback journal when asked
	// for WAL, as it does on a network filesystem.
	s, err := embeddedSchema()
	testutil.Must(t, err)
	_, err = open(ctx(t), filepath.Join(t.TempDir(), "app.db"), options{schema: s, extra: []string{"vfs=unix-dotfile"}})
	if !errors.Is(err, ErrNotWAL) || !strings.Contains(err.Error(), `journal mode "delete"`) {
		t.Fatalf("Open = %v, want ErrNotWAL", err)
	}
}

func TestCheckpointDoesNotHoldAWriterBack(t *testing.T) {
	d := openT(t, filepath.Join(t.TempDir(), "app.db"))
	write := func(key string) {
		t.Helper()
		testutil.Must(t, d.Write(ctx(t), func(tx *sql.Tx) error { return SetMeta(ctx(t), tx, key, "v") }))
	}
	write("a")
	// Hold a reader on an older snapshot. A TRUNCATE checkpoint must wait for it.
	rtx, err := d.R.BeginTx(ctx(t), &sql.TxOptions{ReadOnly: true})
	testutil.Must(t, err)
	defer func() { _ = rtx.Rollback() }()
	var n int
	testutil.Must(t, rtx.QueryRow(`SELECT count(*) FROM meta`).Scan(&n))
	write("b")

	m, err := sql.Open("sqlite", d.dsn(maintenanceBusyMS))
	testutil.Must(t, err)
	defer func() { _ = m.Close() }()
	done := make(chan bool, 1)
	go func() {
		busy, err := d.checkpoint(context.Background(), m, 0, discard())
		if err != nil {
			t.Error(err)
		}
		done <- busy
	}()
	time.Sleep(20 * time.Millisecond)
	start := time.Now()
	write("c")
	if held := time.Since(start); held > 500*time.Millisecond {
		t.Fatalf("a writer waited %v behind the checkpoint", held)
	}
	if busy := <-done; !busy {
		t.Fatal("the checkpoint did not fall back while a reader was behind")
	}
}

func TestMaintainEndsWithItsContext(t *testing.T) {
	d := openT(t, filepath.Join(t.TempDir(), "app.db"))
	c, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		d.Maintain(c)
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Maintain still running 1s after its context ended")
	}
}

func openT(t *testing.T, path string) *DB {
	t.Helper()
	d, err := Open(ctx(t), path)
	testutil.Must(t, err)
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// schemaOf returns the statements in sqlite_schema, tables first and then by name. Comments are
// dropped and the whitespace on each line is collapsed.
func schemaOf(t *testing.T, c *sql.DB) string {
	t.Helper()
	var b strings.Builder
	rows, err := c.Query(`SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite%'
		ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`)
	testutil.Must(t, err)
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var stmt string
		testutil.Must(t, rows.Scan(&stmt))
		var lines []string
		for line := range strings.SplitSeq(stripComments(stmt), "\n") {
			if line = strings.Join(strings.Fields(line), " "); line != "" {
				lines = append(lines, line)
			}
		}
		b.WriteString(strings.Join(lines, "\n") + ";\n")
	}
	testutil.Must(t, rows.Err())
	return b.String()
}

func fileSum(t *testing.T, path string) [32]byte {
	t.Helper()
	b, err := os.ReadFile(path)
	testutil.Must(t, err)
	return sha256.Sum256(b)
}

func ctx(t *testing.T) context.Context { return t.Context() }

func discard() *slog.Logger { return slog.New(slog.DiscardHandler) }
