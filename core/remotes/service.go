package remotes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/operations"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/rclone"
)

var ErrNotFound = errs.NotFound("remote", "That remote doesn’t exist.")

type FSInfo struct {
	Features     map[string]bool  `json:"features"`
	MetadataInfo *fs.MetadataInfo `json:"metadataInfo,omitempty"`
	Hashes       []string         `json:"hashes"`
	Precision    int64            `json:"precision"` // ns
}

// HealthResult reports whether a remote works. Its state is one of:
//   - ok, with the quota when the backend supports `about`
//   - faulty, with rclone's error. canReconnect is set on the remote whose sign-in expired,
//     never on a wrapper over it.
//   - checking, when there is no result yet, or the last one is stale
//   - unknown, when the last check got no response within the timeout and there was no earlier
//     result
//
// Error is the problem's message in the app's language. It is filled in when the result leaves
// for a page (shown).
type HealthResult struct {
	State        string `json:"state"`
	About        *Quota `json:"about,omitempty"`
	Error        string `json:"error,omitempty"`
	CanReconnect bool   `json:"canReconnect,omitempty"`

	problem error
}

func (r HealthResult) shown() HealthResult {
	r.Error = i18n.Localize(r.problem)
	return r
}

const (
	HealthOK       = "ok"
	HealthFaulty   = "faulty"
	HealthChecking = "checking"
	HealthUnknown  = "unknown"
)

type Quota = fs.Usage

type Step struct {
	ID       string
	Remote   string
	Kind     string
	Type     string
	State    string
	Question *fs.Option
	Notice   string
	AuthURL  string
	Error    error
	Field    string
	Busy     string
	Result   *StepResult
}

const (
	KindCreate    = "create"
	KindUpdate    = "update"
	KindReconnect = "reconnect"

	StateQuestion  = "question"
	StateAuthorize = "authorize"
	StateWorking   = "working"
	StateDone      = "done"
	StateFailed    = "failed"
	StateCancelled = "cancelled"
)

type StepResult struct {
	Name         string
	NotRewritten []error
}

type StartRequest struct {
	Kind           string
	Name           string
	NewName        string
	Type           string
	Values         map[string]any
	NonInteractive bool
}

type Claim struct {
	Granted bool
	Holder  string
}

type Invalidator interface{ InvalidateRemotes(names []string) }

// Follower keeps what names a remote in step with a rename. RenameRemote reports the items it
// couldn't rewrite with a *location.NotRewrittenError. Any other error is listed unchanged.
type Follower interface {
	RenameRemote(ctx context.Context, old, new string) error
}

type Unlocks interface{ OnUnlocked(fn func()) }

// Options configure the service. Every field is required.
type Options struct {
	DB          *db.DB
	Store       *rclone.Store
	Bus         *bus.Bus
	Run         syncx.Runner
	Config      Unlocks
	Invalidator Invalidator
	// Followers follow a rename, in this order, after the config file and the remote's row.
	Followers []Follower
	// Edited is called after the config's remotes changed: an edit, a rename, a delete, a new
	// remote, a save of the file in the app or outside it, or an unlock. names are the remotes that
	// changed and the remotes that wrap them (WrappersOf).
	Edited func(names []string)
}

// Service exists once per process, because rclone's config is process-wide.
type Service struct {
	db        *db.DB
	st        *rclone.Store
	bus       *bus.Bus
	run       syncx.Runner
	config    Unlocks
	inv       Invalidator
	followers []Follower
	edits     func(names []string)
	log       *slog.Logger
	now       func() time.Time

	health   *healthCache
	fsinfo   *fsinfoCache
	sessions *Sessions
	claims   *Claims

	holdMu  sync.Mutex
	holding int
	held    []string
}

// New creates the service for rclone's store. It starts nothing, and reads and writes nothing
// until Start.
func New(o Options) *Service {
	s := &Service{
		db: o.DB, st: o.Store, bus: o.Bus, run: o.Run, config: o.Config,
		inv: o.Invalidator, followers: o.Followers, edits: o.Edited,
		log: logs.Logger(logs.CompRclone, "remotes"),
		now: time.Now,
	}
	s.health = newHealthCache(s)
	s.fsinfo = newFSInfoCache(s)
	s.sessions = newSessions(s)
	s.claims = newClaims(s)
	return s
}

// Start adds a row for each remote that has none and drops the rows of the remotes that are
// gone. Then it handles the changes that come from outside the app: an edit of the file, and the
// unlock of a locked file. A failed sync is only logged.
func (s *Service) Start(ctx context.Context) {
	if err := s.syncSettings(ctx, nil); err != nil {
		s.log.ErrorContext(ctx, "remotes: adding the rows at start", "error", err)
	}
	s.st.OnChange(func(ch rclone.Change) { s.Changed(ch.Sections) })
	s.config.OnUnlocked(func() { s.Changed(s.st.GetSectionList()) })
}

func (s *Service) Sessions() *Sessions { return s.sessions }

func (s *Service) Claims() *Claims { return s.claims }

func (s *Service) loaded() bool { return s.st.State().Status == rclone.StatusOK }

func (s *Service) names() []string {
	var out []string
	for _, name := range s.st.GetSectionList() {
		if t, ok := s.st.GetValue(name, "type"); ok && t != "" {
			out = append(out, name)
		}
	}
	return out
}

func (s *Service) exists(name string) bool {
	t, ok := s.st.GetValue(name, "type")
	return ok && t != ""
}

func (s *Service) section(name string) map[string]string {
	keys := s.st.GetKeyList(name)
	if keys == nil {
		return nil
	}
	out := make(map[string]string, len(keys))
	for _, k := range keys {
		out[k], _ = s.st.GetValue(name, k)
	}
	return out
}

type RemoteEntry struct {
	Name   string
	Type   string
	FSInfo *FSInfo
}

type settingsRow struct {
	fsinfo   *FSInfo
	fsinfoMS int64
}

// List returns every remote in config order, with its type and cached fsinfo. A missing or old
// fsinfo is queued for a refresh in the background, and remotes.changed reports when it arrives.
// List itself never contacts a remote.
func (s *Service) List(ctx context.Context) ([]RemoteEntry, error) {
	names := s.names()
	rows, err := s.readSettings(ctx)
	if err != nil {
		return nil, err
	}
	var missing []string
	for _, n := range names {
		if _, ok := rows[n]; !ok {
			missing = append(missing, n)
		}
	}
	if len(missing) > 0 {
		if err := s.addRows(ctx, missing); err != nil {
			return nil, err
		}
		if rows, err = s.readSettings(ctx); err != nil {
			return nil, err
		}
	}
	now := s.now()
	out := make([]RemoteEntry, 0, len(names))
	var stale []string
	for _, n := range names {
		row := rows[n]
		t, _ := s.st.GetValue(n, "type")
		out = append(out, RemoteEntry{Name: n, Type: t, FSInfo: row.fsinfo})
		if row.fsinfo == nil || now.Sub(time.UnixMilli(row.fsinfoMS)) >= fsinfoMaxAge {
			stale = append(stale, n)
		}
	}
	s.fsinfo.queue(stale)
	return out, nil
}

func (s *Service) readSettings(ctx context.Context) (map[string]settingsRow, error) {
	rows := map[string]settingsRow{}
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		r, err := tx.QueryContext(ctx, `SELECT remote, fsinfo, fsinfo_ms FROM remote_fsinfo`)
		if err != nil {
			return err
		}
		defer func() { _ = r.Close() }()
		for r.Next() {
			var (
				name   string
				row    settingsRow
				info   sql.NullString
				infoMS sql.NullInt64
			)
			if err := r.Scan(&name, &info, &infoMS); err != nil {
				return err
			}
			if info.Valid {
				var fi FSInfo
				if json.Unmarshal([]byte(info.String), &fi) == nil {
					row.fsinfo, row.fsinfoMS = &fi, infoMS.Int64
				}
			}
			rows[name] = row
		}
		return r.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("read remote settings: %w", err)
	}
	return rows, nil
}

func (s *Service) addRows(ctx context.Context, names []string) error {
	now := s.now().UnixMilli()
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		for _, n := range names {
			if _, err := tx.ExecContext(ctx, `INSERT INTO remote_fsinfo (remote, updated_ms)
				VALUES (?, ?) ON CONFLICT (remote) DO NOTHING`, n, now); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("add remote rows: %w", err)
	}
	return nil
}

func (s *Service) syncSettings(ctx context.Context, refresh []string) error {
	if !s.loaded() {
		return nil
	}
	names := s.names()
	now := s.now().UnixMilli()
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		r, err := tx.QueryContext(ctx, `SELECT remote FROM remote_fsinfo`)
		if err != nil {
			return err
		}
		stored, err := db.Collect(r, func(row db.Scanner) (string, error) {
			var n string
			err := row.Scan(&n)
			return n, err
		})
		if err != nil {
			return err
		}
		have := map[string]bool{}
		for _, n := range stored {
			have[n] = true
		}
		for _, n := range names {
			if have[n] {
				delete(have, n)
				continue
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO remote_fsinfo (remote, updated_ms)
				VALUES (?, ?)`, n, now); err != nil {
				return err
			}
		}
		for n := range have {
			if _, err := tx.ExecContext(ctx, `DELETE FROM remote_fsinfo WHERE remote = ?`, n); err != nil {
				return err
			}
		}
		for _, n := range refresh {
			if _, err := tx.ExecContext(ctx, `UPDATE remote_fsinfo SET fsinfo = NULL, fsinfo_ms = NULL,
				updated_ms = ? WHERE remote = ? AND fsinfo IS NOT NULL`, now, n); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("sync remote settings: %w", err)
	}
	return nil
}

// Changed handles a config change for the sections that changed. For those remotes, and for every
// wrapper over them, it drops rclone's cached Fs, the health results, the listings and the
// fsinfo. It then adds and prunes rows and publishes remotes.changed.
func (s *Service) Changed(sections []string) {
	s.holdMu.Lock()
	if s.holding > 0 {
		s.held = append(s.held, sections...)
		s.holdMu.Unlock()
		return
	}
	s.holdMu.Unlock()
	s.edited(s.changed(sections))
}

func (s *Service) edited(affected []string) {
	if len(affected) > 0 {
		s.edits(affected)
	}
}

func (s *Service) changed(sections []string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	affected := rclone.WrappersOf(s.st.ConfigMap(), sections)
	// Clear only the remotes that the change affects. Clear would shut down every cached Fs,
	// including those running transfers, and Dropbox's batcher would then fail the upload.
	// Overridden remotes (name{hash}:) and connection strings can't be found by name, so they
	// expire after 5 idle minutes.
	for _, n := range affected {
		cache.ClearConfig(n)
	}
	s.health.forget(affected)
	s.fsinfo.forget(affected)
	if len(affected) > 0 {
		s.inv.InvalidateRemotes(affected)
	}
	if err := s.syncSettings(ctx, affected); err != nil {
		s.log.ErrorContext(ctx, "remotes: config change", "error", err)
	}
	s.bus.Publish(bus.RemotesChanged, bus.RemotesChangedData{Names: affected})
	return affected
}

func (s *Service) hold() {
	s.holdMu.Lock()
	s.holding++
	s.holdMu.Unlock()
}

func (s *Service) release(sections ...string) {
	s.holdMu.Lock()
	s.holding--
	if s.holding > 0 {
		s.held = append(s.held, sections...)
		s.holdMu.Unlock()
		return
	}
	all := append(s.held, sections...)
	s.held = nil
	s.holdMu.Unlock()
	s.edited(s.changed(all))
}

// Values returns a remote's config as stored, including secrets, with password fields obscured
// as config/get returns them.
func (s *Service) Values(name string) (typ string, values map[string]string, err error) {
	sec := s.section(name)
	if sec["type"] == "" {
		return "", nil, ErrNotFound
	}
	return sec["type"], sec, nil
}

func askFSInfo(ctx context.Context, fsName, group string) (FSInfo, error) {
	defer rclone.DeleteGroup(context.WithoutCancel(ctx), group)
	var fi FSInfo
	_, err := rclone.Run(ctx, rclone.CallOpts{Group: group}, func(ctx context.Context) error {
		f, err := cache.Get(ctx, fsName)
		if err != nil {
			return err
		}
		fi = fsinfoFrom(operations.GetFsInfo(f))
		return nil
	})
	return fi, err
}

func fsinfoFrom(info *operations.FsInfo) FSInfo {
	return FSInfo{
		Features: info.Features, MetadataInfo: info.MetadataInfo, Hashes: info.Hashes,
		Precision: info.Precision.Nanoseconds(),
	}
}

func (s *Service) Delete(ctx context.Context, name string) error {
	if !s.exists(name) {
		return ErrNotFound
	}
	err := s.deleteSection(name)
	s.Changed([]string{name})
	return err
}

// Unlike rclone's SaveConfig, which only logs a failed save, it returns the error.
func (s *Service) deleteSection(name string) error {
	s.st.DeleteSection(name)
	if err := s.st.Save(); err != nil {
		return fmt.Errorf("saving the config file: %w", err)
	}
	return nil
}

// saveError returns why the config file couldn't be saved, or nil. rclone's SaveConfig only logs
// a failed save, so the file is saved once more here.
func (s *Service) saveError() error {
	if err := s.st.Save(); err != nil {
		return err
	}
	if why := s.st.State().SaveError; why != "" {
		return errs.Said(errs.CodeFailed, i18n.Saved(why))
	}
	return nil
}

// CheckName refuses a new remote's name with an errs.Field error on "name", or returns nil. It
// applies rclone's rules, refuses a single letter on every OS (it is a drive letter on Windows),
// and refuses a name that is already taken. A create writes its section before its sign-in, so
// that section doesn't count as taken while the create runs.
func (s *Service) CheckName(name string) error {
	taken := s.st.GetSectionList()
	if own := s.sessions.creating(); own != "" {
		taken = slices.DeleteFunc(slices.Clone(taken), func(n string) bool { return n == own })
	}
	return rclone.CheckNewRemoteName("name", name, taken)
}
