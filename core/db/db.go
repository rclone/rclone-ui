// Package db opens app.db, the core's single SQLite file. It sets the connection pragmas, keeps
// one writer and a pool of readers, makes or checks the schema (schema.go) and maintains the
// file. Only the core opens it.
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"modernc.org/sqlite" // driver "sqlite"

	"github.com/rclone/rclone-ui/core/errs"
)

var (
	// ErrSchemaChanged means the file was made with a schema other than this build's. Its data
	// folder has to be deleted, because the database isn't migrated before the release.
	ErrSchemaChanged = errors.New("database was made with a different schema")
	// ErrNotWAL means the filesystem refused the write-ahead log, as a network share may.
	ErrNotWAL = errors.New("database cannot use the write-ahead log")
)

// DB is the database file. Every write goes through W, a single connection that takes the write
// lock at BEGIN. Reads go through R, whose connections are query-only.
type DB struct {
	W    *sql.DB // writer: 1 connection, _txlock=immediate
	R    *sql.DB // reader: query_only, 4 connections
	Path string

	extra []string // DSN parameters added to every connection (tests use them to pick a VFS)
}

type options struct {
	schema schema
	extra  []string
}

// Open creates the file (0600) if it's missing, applies the DSN pragmas, and refuses any journal
// mode other than WAL. It then gives a new file this build's schema, and refuses a file that was
// made with another schema (schema.go).
func Open(ctx context.Context, path string) (*DB, error) {
	s, err := embeddedSchema()
	if err != nil {
		return nil, err
	}
	return open(ctx, path, options{schema: s})
}

func open(ctx context.Context, path string, o options) (*DB, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	// Create the file with our mode, because SQLite would create it with the umask's mode.
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	_ = f.Close()

	d := &DB{Path: path, extra: o.extra}
	d.W, err = sql.Open("sqlite", d.dsn(5000, "_txlock=immediate"))
	if err != nil {
		return nil, err
	}
	d.W.SetMaxOpenConns(1)
	d.W.SetMaxIdleConns(1)
	fail := func(err error) (*DB, error) {
		_ = d.Close()
		return nil, err
	}

	var mode string
	if err := d.W.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		return fail(fmt.Errorf("open %s: %w", path, err))
	}
	if !strings.EqualFold(mode, "wal") {
		return fail(&reason{kind: ErrNotWAL, msg: fmt.Sprintf(
			"%s: the filesystem cannot host the database: the write-ahead log was refused (journal mode %q); the data directory must be on a local filesystem",
			path, mode)})
	}
	if err := d.applySchema(ctx, o.schema); err != nil {
		return fail(err)
	}
	if _, err := d.W.ExecContext(ctx, "PRAGMA optimize=0x10002"); err != nil {
		return fail(fmt.Errorf("optimize %s: %w", path, err))
	}

	d.R, err = sql.Open("sqlite", d.dsn(5000, "_pragma=query_only(1)"))
	if err != nil {
		return fail(err)
	}
	d.R.SetMaxOpenConns(4)
	d.R.SetMaxIdleConns(4)
	if err := d.R.PingContext(ctx); err != nil {
		return fail(fmt.Errorf("open %s: %w", path, err))
	}
	return d, nil
}

// Write runs fn in one immediate transaction on the writer, committed when fn returns nil. A
// failure of the database itself comes back as errs.Internal (see dbError).
func (d *DB) Write(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return dbError(inTx(ctx, d.W, nil, fn))
}

// Read runs fn in one read transaction on a reader, so everything fn reads comes from one
// snapshot. Keep fn short and close every *sql.Rows, because an open read keeps the WAL from
// being checkpointed. A failure of the database itself comes back as errs.Internal, as for Write.
func (d *DB) Read(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return dbError(inTx(ctx, d.R, &sql.TxOptions{ReadOnly: true}, fn))
}

// dbError marks a failure of SQLite or of database/sql as errs.Internal. The user couldn't have
// prevented a full disk or a broken file by changing the request, and a page that tried again
// would only fail again. The core's own errors and a canceled call pass unchanged, and so does
// any other error that fn returned, such as one of rclone's. errors.Is and errors.As still see
// the wrapped error.
func dbError(err error) error {
	if err == nil || errs.Of(err) != nil {
		return err
	}
	var se *sqlite.Error
	if errors.As(err, &se) || errors.Is(err, sql.ErrNoRows) || errors.Is(err, sql.ErrTxDone) || errors.Is(err, sql.ErrConnDone) {
		return errs.Internal(err)
	}
	return err
}

// Close closes both pools. The last connection to close checkpoints the WAL.
func (d *DB) Close() error {
	var errs []error
	if d.R != nil {
		errs = append(errs, d.R.Close())
	}
	if d.W != nil {
		errs = append(errs, d.W.Close())
	}
	return errors.Join(errs...)
}

// NowMS returns the current time in UTC milliseconds, the format of every time column.
func NowMS() int64 { return time.Now().UnixMilli() }

func inTx(ctx context.Context, pool *sql.DB, opts *sql.TxOptions, fn func(tx *sql.Tx) error) (err error) {
	tx, err := pool.BeginTx(ctx, opts)
	if err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// dsn returns the connection string. The pragmas apply per connection, so they are set here.
// modernc runs busy_timeout first and then the other _pragma values in sorted order, on every
// new connection. When an Exec holds several statements, modernc binds the arguments to each
// statement starting from the first, so an Exec that takes arguments must hold one statement.
func (d *DB) dsn(busyMS int, extra ...string) string {
	q := []string{
		fmt.Sprintf("_pragma=busy_timeout(%d)", busyMS),
		"_pragma=foreign_keys(1)",
		"_pragma=journal_mode(WAL)",
		"_pragma=synchronous(NORMAL)",
		"_pragma=journal_size_limit(67108864)",
	}
	q = append(q, extra...)
	q = append(q, d.extra...)
	return fileURI(d.Path) + "?" + strings.Join(q, "&")
}

// fileURI turns path into a SQLite URI filename. '?', '#' and '%' are escaped, because they
// would otherwise end the filename or start an escape.
func fileURI(path string) string {
	p := filepath.ToSlash(path)
	if runtime.GOOS == "windows" && !strings.HasPrefix(p, "/") {
		p = "/" + p // file:/C:/…
	}
	return "file:" + strings.NewReplacer("%", "%25", "?", "%3f", "#", "%23").Replace(p)
}

// reason is an error whose text is its whole message. errors.Is matches it to one of the
// sentinel errors above, and to its cause if it has one.
type reason struct {
	kind  error
	msg   string
	cause error
}

func (e *reason) Error() string { return e.msg }

func (e *reason) Unwrap() []error {
	if e.cause == nil {
		return []error{e.kind}
	}
	return []error{e.kind, e.cause}
}
