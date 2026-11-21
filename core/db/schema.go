package db

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"strings"
)

// Rclone UI 4 isn't released, so its database is never migrated. A schema file is edited in
// place, and a file made with any other schema is refused, with a message that asks for a new
// data folder. To notice an edit, a new file records a hash of the schema files in meta.schema,
// and every later start compares it with this build's hash. Migrations come back with the first
// release.

//go:embed migrations
var embedded embed.FS

// schemaKey is the meta key that holds the hash of the schema that made the file.
const schemaKey = "schema"

var schemaFileName = regexp.MustCompile(`^\d{4}_[a-z0-9_]+\.sql$`)

// schema is the SQL that makes a new file, and its hash.
type schema struct {
	files []schemaFile
	hash  string
}

type schemaFile struct {
	name string // "0002_settings.sql"
	sql  string
}

// loadSchema reads the NNNN_<what>.sql files at the root of fsys, in name order (fs.ReadDir
// sorts them), and skips the README. The hash covers each file's name and its SQL without
// comments and with its whitespace collapsed, so that editing a comment or the layout doesn't
// ask for a new data folder.
func loadSchema(fsys fs.FS) (schema, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return schema{}, err
	}
	var s schema
	h := sha256.New()
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue // the README
		}
		if !schemaFileName.MatchString(e.Name()) {
			return schema{}, fmt.Errorf("migrations/%s: not a schema file name (NNNN_what.sql)", e.Name())
		}
		body, err := fs.ReadFile(fsys, e.Name())
		if err != nil {
			return schema{}, err
		}
		s.files = append(s.files, schemaFile{name: e.Name(), sql: string(body)})
		h.Write([]byte(e.Name() + "\x00" + strings.Join(strings.Fields(stripComments(string(body))), " ") + "\x00"))
	}
	if len(s.files) == 0 {
		return schema{}, errors.New("migrations: no schema files")
	}
	s.hash = hex.EncodeToString(h.Sum(nil))
	return s, nil
}

// embeddedSchema is the schema that this build makes and expects.
func embeddedSchema() (schema, error) {
	sub, err := fs.Sub(embedded, "migrations")
	if err != nil {
		return schema{}, err
	}
	return loadSchema(sub)
}

// applySchema gives an empty file every schema file and the schema's hash, in one transaction,
// so a file is either complete or still empty. A file that holds anything must have been made
// with this same schema, and is otherwise refused without being written to.
func (d *DB) applySchema(ctx context.Context, s schema) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		var objects int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_schema`).Scan(&objects); err != nil {
			return fmt.Errorf("open %s: %w", d.Path, err)
		}
		if objects > 0 {
			return d.checkSchema(ctx, tx, s.hash)
		}
		for _, f := range s.files {
			if _, err := tx.ExecContext(ctx, f.sql); err != nil {
				return fmt.Errorf("%s: schema file %s failed: %w", d.Path, f.name, err)
			}
		}
		return SetMeta(ctx, tx, schemaKey, s.hash)
	})
}

// checkSchema returns ErrSchemaChanged unless the file's meta.schema is hash. A file without a
// meta table, or without the key, is refused too.
func (d *DB) checkSchema(ctx context.Context, tx *sql.Tx, hash string) error {
	var tables int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'meta'`).Scan(&tables); err != nil {
		return fmt.Errorf("open %s: %w", d.Path, err)
	}
	var got string
	if tables > 0 {
		err := tx.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, schemaKey).Scan(&got)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("open %s: %w", d.Path, err)
		}
	}
	if got == hash {
		return nil
	}
	dir := filepath.Dir(d.Path)
	return &reason{kind: ErrSchemaChanged, msg: fmt.Sprintf(
		"%s was made with a different schema. Rclone UI 4 isn't released, so its database isn't migrated. Quit, delete the data folder %s, and start again.",
		d.Path, dir)}
}

// stripComments removes the -- comments from SQL, and leaves the quoted text alone.
func stripComments(s string) string {
	var b strings.Builder
	var quote rune
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			}
		case r == '\'' || r == '"' || r == '`':
			quote = r
		case r == '-' && i+1 < len(rs) && rs[i+1] == '-':
			for i < len(rs) && rs[i] != '\n' {
				i++
			}
			if i < len(rs) {
				b.WriteRune('\n')
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
