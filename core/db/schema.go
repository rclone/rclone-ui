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

//go:embed migrations
var embedded embed.FS

const schemaKey = "schema"

var schemaFileName = regexp.MustCompile(`^\d{4}_[a-z0-9_]+\.sql$`)

type schema struct {
	files []schemaFile
	hash  string
}

type schemaFile struct {
	name string
	sql  string
}

func loadSchema(fsys fs.FS) (schema, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return schema{}, err
	}
	var s schema
	h := sha256.New()
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
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

func embeddedSchema() (schema, error) {
	sub, err := fs.Sub(embedded, "migrations")
	if err != nil {
		return schema{}, err
	}
	return loadSchema(sub)
}

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
