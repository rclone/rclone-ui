// Package templates stores the option templates. A template is a set of flat rclone flags saved
// under a name, and maybe the paths that its operation runs on. The operation, Mount and Serve
// pages offer the templates that carry their tag, and the Templates page runs them.
package templates

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/operations"
)

// Tags lists every tag, in the order that the pages show them.
var Tags = []operations.Operation{
	operations.OperationCopy, operations.OperationMove, operations.OperationSync,
	operations.OperationBisync, operations.OperationDelete, operations.OperationPurge,
	operations.OperationMount, operations.OperationServe,
}

// maxIDLen is the longest id a template can have. Pages may create the id (with
// crypto.randomUUID), so the core only checks that it is a plain token.
const maxIDLen = 64

// Service reads and writes the templates table. Every change publishes templates.changed.
type Service struct {
	db  *db.DB
	bus *bus.Bus
	// exe is the running executable, which an export puts in front of the app's own metadata
	// mapper.
	exe string
}

func New(d *db.DB, b *bus.Bus, exe string) *Service { return &Service{db: d, bus: b, exe: exe} }

// columns are the columns that scan reads. paths is NULL for a template without paths.
const columns = `id, name, tags, options, paths`

func scan(row db.Scanner) (*Template, error) {
	var t Template
	var tags, options string
	var paths sql.NullString
	if err := row.Scan(&t.ID, &t.Name, &tags, &options, &paths); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(tags), &t.Tags); err != nil {
		return nil, fmt.Errorf("template %s: tags: %w", t.ID, err)
	}
	if err := json.Unmarshal([]byte(options), &t.Options); err != nil {
		return nil, fmt.Errorf("template %s: options: %w", t.ID, err)
	}
	if paths.Valid {
		t.Paths = &Paths{}
		if err := json.Unmarshal([]byte(paths.String), t.Paths); err != nil {
			return nil, fmt.Errorf("template %s: paths: %w", t.ID, err)
		}
		if t.Paths.Sources == nil {
			t.Paths.Sources = []string{}
		}
	}
	return &t, nil
}

func (s *Service) Get(ctx context.Context, id string) (*Template, error) {
	var t *Template
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		var err error
		t, err = scan(tx.QueryRowContext(ctx, `SELECT `+columns+` FROM templates WHERE id = ?`, id))
		return err
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("read template %s: %w", id, err)
	}
	return t, nil
}

// List returns every template, in the list's order (oldest first).
func (s *Service) List(ctx context.Context) ([]*Template, error) {
	var out []*Template
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT `+columns+` FROM templates ORDER BY position, created_at`)
		if err != nil {
			return err
		}
		out, err = db.Collect(rows, scan)
		return err
	})
	return out, err
}

var ErrNotFound = errs.NotFound("template", "This template no longer exists.")

// Check normalizes t before it is saved. It trims the name, checks that each tag is known and
// keeps it only once, and checks that each option's value is JSON. It drops blank sources and
// trims the destination, and refuses a path that rclone would refuse or misread. It also refuses
// several sources when one of the tags is sync, bisync, mount or serve (oneSource). A missing id
// is replaced by a new one.
func Check(t *Template) (*Template, error) {
	out := &Template{ID: t.ID, Name: strings.TrimSpace(t.Name)}
	if out.ID == "" {
		out.ID = uuid.NewString() // the same kind of id that pages create
	}
	if !validID(out.ID) {
		return nil, errs.Field("id", "A template's ID is a short token of letters, digits and dashes.")
	}
	if out.Name == "" {
		return nil, errs.Field("name", "Please enter a name for the template")
	}
	for _, tag := range t.Tags {
		if !slices.Contains(Tags, tag) {
			return nil, errs.Field("tags", "A template is not for %q.", tag)
		}
		if !slices.Contains(out.Tags, tag) {
			out.Tags = append(out.Tags, tag)
		}
	}
	if out.Tags == nil {
		out.Tags = []operations.Operation{}
	}
	out.Options = catalog.Group{}
	for key, value := range t.Options {
		if !json.Valid(value) {
			return nil, errs.Field("options", "The value of %s is not valid JSON.", key)
		}
		out.Options[key] = value
	}
	out.Paths = normalizePaths(t.Paths)
	if out.Paths != nil {
		if err := checkPaths(out.Paths); err != nil {
			return nil, err
		}
		if err := oneSource(out.Tags, out.Paths); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// oneSourceTags are the operations that take exactly one source. rclone's sync and bisync take
// one source and one destination, and a mount or a serve shares one folder. A template for one of
// them can't run its other sources, and syncing several sources into one destination would let
// each sync delete what the one before it copied.
var oneSourceTags = []operations.Operation{
	operations.OperationSync, operations.OperationBisync, operations.OperationMount, operations.OperationServe,
}

// oneSource refuses several sources when one of tags takes exactly one (oneSourceTags).
func oneSource(tags []operations.Operation, p *Paths) error {
	if len(p.Sources) < 2 {
		return nil
	}
	for _, tag := range tags {
		switch tag {
		case operations.OperationSync:
			return errs.Field("paths", "A Sync takes one source. Remove the other sources, or the Sync tag.")
		case operations.OperationBisync:
			return errs.Field("paths", "A Bisync takes one source. Remove the other sources, or the Bisync tag.")
		case operations.OperationMount:
			return errs.Field("paths", "A Mount takes one source. Remove the other sources, or the Mount tag.")
		case operations.OperationServe:
			return errs.Field("paths", "A Serve takes one source. Remove the other sources, or the Serve tag.")
		}
	}
	return nil
}

// normalizePaths drops blank sources and trims the destination. It returns nil when no path is
// left.
func normalizePaths(p *Paths) *Paths {
	if p == nil {
		return nil
	}
	out := &Paths{Sources: []string{}, Destination: strings.TrimSpace(p.Destination)}
	for _, src := range p.Sources {
		if strings.TrimSpace(src) != "" {
			out.Sources = append(out.Sources, src)
		}
	}
	if len(out.Sources) == 0 && out.Destination == "" {
		return nil
	}
	return out
}

// checkPaths refuses a path that rclone would refuse or misread (location.Problem). A mount
// point on Windows can be a drive letter or `*`, which are not paths.
func checkPaths(p *Paths) error {
	paths := slices.Clone(p.Sources)
	if !isDrive(p.Destination) {
		paths = append(paths, p.Destination)
	}
	for _, path := range paths {
		if problem := location.Problem(path); !problem.IsZero() {
			// i18n: A path, then why it can't be used.
			return errs.Field("paths", "%s: %s", path, problem)
		}
	}
	return nil
}

// isDrive reports whether p is a drive letter (`M:`) or `*`, which a Windows mount takes.
func isDrive(p string) bool {
	if p == "*" {
		return true
	}
	return len(p) == 2 && p[1] == ':' && (p[0] >= 'a' && p[0] <= 'z' || p[0] >= 'A' && p[0] <= 'Z')
}

func validID(id string) bool {
	if id == "" || len(id) > maxIDLen {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// Save checks t with Check and stores it. A template can't set a metadata mapper without
// `metadata`, a template for a transfer can't set an option that rclone sets once for the whole
// app (operations.CheckTemplate), and each of its options must be one that an operation of its
// tags takes (checkOptions). The app's own metadata mapper is stored as the mapping panel writes
// it (operations.StoreMapper). A new id adds the template at the end of the list. A known id
// replaces the template, which keeps its place and creation time.
func (s *Service) Save(ctx context.Context, t *Template) (*Template, error) {
	t, err := Check(t)
	if err != nil {
		return nil, err
	}
	if err := operations.CheckTemplate(t.Tags, t.Options); err != nil {
		return nil, err
	}
	if err := checkOptions(t.Tags, t.Options); err != nil {
		return nil, err
	}
	// The options are copied, so the caller's template doesn't change.
	t.Options = maps.Clone(t.Options)
	mapper := operations.Groups{Config: t.Options}
	if err := operations.StoreMapper(&mapper); err != nil {
		return nil, err
	}
	if err := s.db.Write(ctx, func(tx *sql.Tx) error { return put(ctx, tx, t) }); err != nil {
		return nil, fmt.Errorf("save template %s: %w", t.ID, err)
	}
	s.bus.Publish(bus.TemplatesChanged, nil)
	return t, nil
}

// checkOptions refuses an option that none of the operations of tags takes, as their starts
// would (operations.CheckOption). An option that only some of them take is kept: copy and mount
// can share a template whose vfs options only the mount uses, and a run leaves out what its
// operation doesn't take. A blank value is left out, as a start leaves it out. The error names
// the first operation that refused it.
func checkOptions(tags []operations.Operation, options catalog.Group) error {
	for _, key := range slices.Sorted(maps.Keys(options)) {
		if isBlank(options[key]) || len(tags) == 0 {
			continue
		}
		var first error
		var firstTag operations.Operation
		taken := false
		for _, tag := range tags {
			err := operations.CheckOption(tag, key)
			if err == nil {
				taken = true
				break
			}
			if first == nil {
				first, firstTag = err, tag
			}
		}
		if !taken {
			return optionRefusal(firstTag, first)
		}
	}
	return nil
}

// optionRefusal returns the refusal of an option that the operation tag doesn't take, with the
// operation as the pages name it, such as Copy, and why.
func optionRefusal(tag operations.Operation, why error) error {
	switch tag {
	case operations.OperationCopy:
		// i18n: An operation of a template, then why it can't take one of the template's options.
		return errs.Field("options", "Copy: %s", why)
	case operations.OperationMove:
		// i18n: An operation of a template, then why it can't take one of the template's options.
		return errs.Field("options", "Move: %s", why)
	case operations.OperationSync:
		// i18n: An operation of a template, then why it can't take one of the template's options.
		return errs.Field("options", "Sync: %s", why)
	case operations.OperationBisync:
		// i18n: An operation of a template, then why it can't take one of the template's options.
		return errs.Field("options", "Bisync: %s", why)
	case operations.OperationDelete:
		// i18n: An operation of a template, then why it can't take one of the template's options.
		return errs.Field("options", "Delete: %s", why)
	case operations.OperationPurge:
		// i18n: An operation of a template, then why it can't take one of the template's options.
		return errs.Field("options", "Purge: %s", why)
	}
	// i18n: An operation of a template, then why it can't take one of the template's options.
	return errs.Field("options", "%s: %s", tag, why)
}

// isBlank reports whether an option's value is cleared, which a start leaves out: null, or text
// that is only spaces.
func isBlank(raw json.RawMessage) bool {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return false
	}
	s, ok := v.(string)
	return v == nil || ok && strings.TrimSpace(s) == ""
}

// put stores a checked template in tx.
func put(ctx context.Context, tx *sql.Tx, t *Template) error {
	tags, err := json.Marshal(t.Tags)
	if err != nil {
		return err
	}
	options, err := marshal(t.Options)
	if err != nil {
		return err
	}
	var paths any // NULL without paths
	if t.Paths != nil {
		raw, err := json.Marshal(t.Paths)
		if err != nil {
			return err
		}
		paths = string(raw)
	}
	now := db.NowMS()
	_, err = tx.ExecContext(ctx, `INSERT INTO templates (id, name, tags, options, paths, position, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM templates), ?, ?)
		ON CONFLICT (id) DO UPDATE SET name = excluded.name, tags = excluded.tags,
			options = excluded.options, paths = excluded.paths, updated_at = excluded.updated_at`,
		t.ID, t.Name, string(tags), options, paths, now, now)
	return err
}

// marshal writes v as JSON without escaping <, > and &, which can appear in paths and filters.
func marshal(v any) (string, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(b.String(), "\n"), nil
}

// Delete removes the templates with the given ids. An unknown id is not an error. It returns how
// many templates it removed.
func (s *Service) Delete(ctx context.Context, ids []string) (int, error) {
	removed := 0
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		removed = 0
		for _, id := range ids {
			res, err := tx.ExecContext(ctx, `DELETE FROM templates WHERE id = ?`, id)
			if err != nil {
				return err
			}
			n, err := res.RowsAffected()
			if err != nil {
				return err
			}
			removed += int(n)
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("remove templates: %w", err)
	}
	if removed > 0 {
		s.bus.Publish(bus.TemplatesChanged, nil)
	}
	return removed, nil
}

// RunArgs returns the form that runs the template saved under id as tag, which must be one
// of its tags (operations.TemplateArgs). A template without paths, or without the tag, has
// nothing to run: its options are applied in a page's form instead.
func (s *Service) RunArgs(ctx context.Context, id string, tag operations.Operation) (operations.Form, error) {
	f, _, err := s.Run(ctx, id, tag)
	return f, err
}

// Run returns the form that runs the template saved under id as tag (RunArgs), and the
// template's name, which History shows as the origin of the transfer.
func (s *Service) Run(ctx context.Context, id string, tag operations.Operation) (operations.Form, string, error) {
	t, err := s.Get(ctx, id)
	if err != nil {
		return operations.Form{}, "", err
	}
	f, err := t.runArgs(tag)
	return f, t.Name, err
}

// Groups returns the options of the template saved under id sorted into the groups of op's form,
// as op's page applies them (operations.TemplateGroups). serve is a serve's type, or "" for every
// type.
func (s *Service) Groups(ctx context.Context, id string, op operations.Operation, serve string) (Applied, error) {
	t, err := s.Get(ctx, id)
	if err != nil {
		return Applied{}, err
	}
	g, skipped, err := operations.TemplateGroups(op, serve, t.Options)
	if err != nil {
		return Applied{}, err
	}
	// The page shows the reasons, so they are in the app's language.
	return Applied{Groups: g, Skipped: catalog.LocalSkipped(skipped)}, nil
}

// Export returns the export file of the templates with the given ids, in the list's order: a JSON
// list with each template's name, options and paths, and its options as rclone's flags for this
// computer's shell (operations.TemplateFlags). An unknown id is left out.
func (s *Service) Export(ctx context.Context, ids []string, goos string) (string, error) {
	all, err := s.List(ctx)
	if err != nil {
		return "", err
	}
	out := []exported{}
	for _, t := range all {
		if !slices.Contains(ids, t.ID) {
			continue
		}
		command, err := operations.TemplateFlags(t.Options, s.exe, goos)
		if err != nil {
			return "", fmt.Errorf("template %s: %w", t.ID, err)
		}
		out = append(out, exported{Name: t.Name, Options: t.Options, Paths: t.Paths, Command: command})
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		return "", err
	}
	return b.String(), nil
}

func (t *Template) runArgs(tag operations.Operation) (operations.Form, error) {
	if t.Paths == nil || !slices.Contains(t.Tags, tag) {
		return operations.Form{}, errs.New("This template has no paths to run for this operation: apply it in its form.")
	}
	return operations.TemplateArgs(tag, t.Paths.Sources, t.Paths.Destination, t.Options)
}
