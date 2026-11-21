package rclone

import (
	"bufio"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configfile"
	"github.com/rclone/rclone/fs/fspath"
	"github.com/unknwon/goconfig" //nolint:misspell // rclone's own spelling
	"golang.org/x/text/unicode/norm"

	"github.com/rclone/rclone-ui/core/children/childenv"
	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/logs"
)

// The active config is rclone's own config file (fs/config/configfile), stored at the path that
// the Config service chose, and read and written by rclone. Store wraps it as rclone's
// config.Storage to handle two things that rclone doesn't handle in a long-lived process:
//
//   - A load never fails. rclone's LoadedData calls Fatalf when Load returns an error
//     (fs/config/config.go:361-382), so a wrong password or a broken file would end the app.
//     The Store loads what it can and reports the result in State: ok, needs a password, or
//     an error.
//   - A failed save is remembered. rclone's SaveConfig only logs a failure after its retries
//     (config.go:386-398). State keeps the error until a save succeeds. While the file isn't
//     loaded, a save is refused rather than attempted, because it would replace the file with
//     an empty one.
//
// Watch reports which sections changed when something outside this process edits the file, such
// as the rclone CLI, an editor, or a mount child refreshing a token.

// Status is the result of loading the active config file.
type Status string

const (
	StatusOK            Status = "ok"
	StatusNeedsPassword Status = "needs-password"
	StatusError         Status = "error"
)

type State struct {
	Path      string
	Status    Status
	Encrypted bool // the file has rclone's encryption header
	// Keyed reports whether rclone holds a key for the file, which means saves are encrypted.
	// If the password was removed outside the app, the file is read as plain text and the key
	// is dropped (see load).
	Keyed bool
	// Message explains why the file isn't loaded. It holds the error, or for NeedsPassword, what
	// was wrong with the password that was tried ("" when none was tried). It is in the form
	// that i18n.Save writes, so that i18n.Saved reads it back to be translated.
	Message string
	// SaveError explains why the last save failed or was refused, in the same form as Message.
	// It is "" once a save succeeds.
	SaveError string
}

// Change describes what an edit made outside this process changed in the active config file.
type Change struct {
	// Sections are the remotes that were added, removed, or changed in anything other than their
	// tokens.
	Sections []string
}

const watchEvery = 2 * time.Second

// Store is the active config file, used as rclone's config.Storage. Open installs it.
type Store struct {
	mu        sync.Mutex                         // guards Open, loads, saves, reloads and the fields below
	inner     atomic.Pointer[configfile.Storage] // nil while no file is loaded
	path      string
	password  bool // Open was given a password and accepted it
	fresh     bool // Open just loaded the file, so the next Load from rclone can reuse it
	installed bool // this Store is rclone's config.Storage
	state     State
	stamp     stamp
	snap      map[string]map[string]string
	// vanished is set when Poll found the loaded file missing or empty. Poll waits for the next
	// check to confirm it before acting.
	vanished bool

	// pathMu guards rclone's config path. That path is a plain global (config.SetConfigPath)
	// which configfile.Storage reads on every access, and Open changes it while a health check or
	// a listing may still be reading the old file. When both locks are needed, take mu first.
	pathMu sync.RWMutex

	hooks sync.Mutex
	onCh  func(Change)
	onSt  func(State)
}

// stamp is used to tell whether a file changed. It uses rclone's own test (configfile.go:34-49),
// plus whether the file exists at all.
type stamp struct {
	exists bool
	size   int64
	mtime  time.Time
}

func stampOf(path string) stamp {
	info, err := os.Stat(path)
	if err != nil {
		return stamp{}
	}
	return stamp{exists: true, size: info.Size(), mtime: info.ModTime()}
}

func (a stamp) equal(b stamp) bool {
	return a.exists == b.exists && a.size == b.size && a.mtime.Equal(b.mtime)
}

// NewStore returns a Store with no file. Open gives it one.
func NewStore() *Store { return &Store{} }

// OnChange sets the function that is called when something outside this process edits the
// file. fn runs on Watch's goroutine, or on the goroutine of a save that found the edit, and it
// may call the Store.
func (s *Store) OnChange(fn func(Change)) {
	s.hooks.Lock()
	defer s.hooks.Unlock()
	s.onCh = fn
}

// OnState sets the function that is called when State changes, for example when a password is
// needed or a save failed. fn may call the Store.
func (s *Store) OnState(fn func(State)) {
	s.hooks.Lock()
	defer s.hooks.Unlock()
	s.onSt = fn
}

// Path returns the path of the active config file ("" before Open).
func (s *Store) Path() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.path
}

func (s *Store) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

// Open makes path the active config file. It sets rclone's config path and password, installs
// this Store as rclone's storage, and loads the file. The password is used only when the file
// is encrypted, and only if it is correct. Open checks it first with CheckPassword, so rclone
// never retries a wrong one.
//
// Opening another file (which only tests do) clears rclone's Fs cache, so no Fs made from the old
// file outlives it.
//
// The file doesn't need to exist, because rclone creates it on the first save. Open returns an
// error only for a path that rclone refuses. State reports how the file loaded.
func (s *Store) Open(path, password string) error {
	if path == "" {
		return errors.New("rclone: no config file path")
	}
	if fs.GetConfig(context.Background()).AskPassword {
		// rclone would ask for an encrypted file's password on the terminal, where nobody can
		// answer. Init turns this off, so it must run first.
		return errors.New("rclone: Open before Init")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if s.Path() != abs {
		cache.Clear()
	}

	s.mu.Lock()
	old := s.state
	s.pathMu.Lock()
	if err := config.SetConfigPath(abs); err != nil {
		s.pathMu.Unlock()
		s.mu.Unlock()
		return fmt.Errorf("rclone: config path %s: %w", abs, err)
	}
	if config.GetConfigPath() == "" {
		// rclone treats os.DevNull, or a file named "notfound", as its in-memory config
		// (config.go:327-341).
		_ = config.SetConfigPath(s.path)
		s.pathMu.Unlock()
		s.mu.Unlock()
		return fmt.Errorf("rclone: %s is rclone's name for no config file", path)
	}
	s.pathMu.Unlock()
	s.path, s.password = abs, false
	encrypted := IsEncrypted(abs)
	config.ClearConfigPassword()
	switch {
	case encrypted && password != "":
		if err := CheckPassword(abs, password); err != nil {
			s.inner.Store(nil)
			s.snap, s.stamp = nil, stampOf(abs)
			s.state = State{Path: abs, Status: StatusNeedsPassword, Encrypted: true, Message: i18n.Save(err)}
			break
		}
		if err := config.SetConfigPassword(password); err != nil {
			s.mu.Unlock()
			return err
		}
		s.password = true
		s.load(false)
	default:
		s.load(false)
	}
	first := !s.installed
	s.installed = true
	s.fresh = first
	now := s.state
	s.mu.Unlock()

	if first {
		// Install the Store after the load, outside s.mu. LoadedData calls Load, which finds
		// the file already loaded, and sets RCLONE_CONFIG_DIR for the backends and the children.
		// This happens only once, because every access reads rclone's data globals without a
		// lock, so a switch must leave them alone.
		config.SetData(s)
		config.LoadedData()
	} else {
		_ = os.Setenv("RCLONE_CONFIG_DIR", filepath.Dir(abs))
	}
	if now != old {
		s.notifyState(now)
	}
	return nil
}

// load reads the active file into a new configfile.Storage. The caller holds s.mu. When the file
// can't be read and keep is true, the previous contents stay loaded, which matches how rclone
// reloads after an outside edit (configfile.go:40-46). When keep is false, nothing stays loaded
// and the Store itself returns an empty config to rclone. It doesn't keep the failed
// configfile.Storage, because that would try again, and log, on every access
// (configfile.go:34-49).
func (s *Store) load(keep bool) {
	in := &configfile.Storage{}
	s.pathMu.RLock()
	err := in.Load()
	s.pathMu.RUnlock()
	st := State{Path: s.path, Status: StatusOK, Encrypted: IsEncrypted(s.path), SaveError: s.state.SaveError}
	s.stamp, s.vanished = stampOf(s.path), false
	switch {
	case err == nil || errors.Is(err, config.ErrorConfigFileNotFound):
		s.inner.Store(in)
		s.snap = snapshot(in)
		if err == nil && !st.Encrypted && config.IsEncrypted() && childenv.PlainConfig(s.path) {
			// The password was removed outside the app. rclone reads a plain file without
			// checking its key (crypt.go:57-86), and would encrypt the next save with the old
			// password. Drop the key, as a child process does (childenv.GuardConfig).
			logs.Logger(logs.CompConfig, logs.SubWatch).Info("the config file's password was removed outside the app", "path", s.path)
			config.ClearConfigPassword()
			s.password = false
		}
		st.Keyed = config.IsEncrypted()
	case st.Encrypted:
		st.Status = StatusNeedsPassword
		if s.password || os.Getenv("RCLONE_CONFIG_PASS") != "" {
			st.Message = i18n.Save(err)
		}
	default:
		st.Status, st.Message = StatusError, i18n.Save(err)
	}
	if st.Status != StatusOK && !keep {
		s.inner.Store(nil)
		s.snap = nil
	}
	if st.Status == StatusOK && s.state.Status != StatusOK {
		st.SaveError = ""
	}
	s.state = st
}

// Watch checks the active file every 2 s until ctx ends. When the file changed and this process
// didn't write it, Watch reloads it and tells OnChange which remotes changed in more than their
// tokens. Tokens are ignored because a mount child that refreshes a token rewrites the file.
// Start it with the core's Go.
func (s *Store) Watch(ctx context.Context) {
	t := time.NewTicker(watchEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Poll()
		}
	}
}

// Poll runs one check for Watch. A reload swaps in a new storage, so a value set in the few
// microseconds before it is saved can be lost. rclone itself can lose an outside edit in the
// same way.
func (s *Store) Poll() {
	s.mu.Lock()
	now := stampOf(s.path)
	if s.path == "" || s.stamp.equal(now) {
		s.vanished = false
		s.mu.Unlock()
		return
	}
	if gone := !now.exists || now.size == 0; gone && s.stamp.exists && s.stamp.size > 0 && !s.vanished {
		// rclone saves by renaming the old file away and then renaming the new one into place
		// (configfile.go:191-197), so a check between the two finds no file. Treat the file as
		// missing or empty only when the next check agrees, just as rclone keeps what it has
		// when it can't read the file.
		s.vanished = true
		s.mu.Unlock()
		return
	}
	logs.Logger(logs.CompConfig, logs.SubWatch).Debug("the config file changed outside the app", "path", s.path)
	oldState, oldSnap := s.state, s.snap
	s.load(true)
	var ch *Change
	if s.state.Status == StatusOK {
		ch = s.change(oldSnap, s.snap)
	}
	st := s.state
	s.mu.Unlock()
	if st != oldState {
		s.notifyState(st)
	}
	if ch != nil {
		s.notifyChange(*ch)
	}
}

// change returns what differs between two snapshots of the file, or nil when only tokens
// changed. The caller holds s.mu. Finding the remotes that wrap the changed sections is left to
// the remotes package (WrappersOf), using the config it holds.
func (s *Store) change(before, after map[string]map[string]string) *Change {
	sections := changedSections(before, after)
	if len(sections) == 0 {
		return nil
	}
	return &Change{Sections: sections}
}

func (s *Store) notifyChange(c Change) {
	s.hooks.Lock()
	fn := s.onCh
	s.hooks.Unlock()
	if fn != nil {
		fn(c)
	}
}

func (s *Store) notifyState(st State) {
	s.hooks.Lock()
	fn := s.onSt
	s.hooks.Unlock()
	if fn != nil {
		fn(st)
	}
}

// snapshot returns all of in, by section and key. It reads everything at once with Serialize,
// which holds in's lock, so a reload can't happen halfway through.
func snapshot(in *configfile.Storage) map[string]map[string]string {
	text, err := in.Serialize()
	if err != nil {
		return nil
	}
	gc, err := goconfig.LoadFromData([]byte(text))
	if err != nil {
		return nil
	}
	out := map[string]map[string]string{}
	for _, name := range gc.GetSectionList() {
		sec := map[string]string{}
		for _, k := range gc.GetKeyList(name) {
			sec[k], _ = gc.GetValue(name, k)
		}
		out[name] = sec
	}
	return out
}

// changedSections returns the sorted sections that were added, removed, or changed in a key that
// isn't a token.
func changedSections(before, after map[string]map[string]string) []string {
	var out []string
	for name := range before {
		if _, ok := after[name]; !ok {
			out = append(out, name)
		}
	}
	for name, sec := range after {
		old, ok := before[name]
		if !ok || !maps.EqualFunc(withoutTokens(old), withoutTokens(sec), func(a, b string) bool { return a == b }) {
			out = append(out, name)
		}
	}
	slices.Sort(out)
	return out
}

func withoutTokens(sec map[string]string) map[string]string {
	out := make(map[string]string, len(sec))
	for k, v := range sec {
		if !isTokenKey(k) {
			out[k] = v
		}
	}
	return out
}

// sessionKeys are the keys, besides token and the *_token keys, that backends rewrite when they
// refresh a sign-in: protondrive's client_uid and client_salted_key_pass
// (protondrive.go:343-346), and iclouddrive's cookies (icloud.go:110-112).
var sessionKeys = []string{"client_uid", "client_salted_key_pass", "cookies"}

// userTokenKeys have "token" in their names but are set by the user, and no backend rewrites
// them, so an edit to one counts as a change. Examples are webdav's bearer_token, s3's
// session_token and an OAuth token_url. Swift's auth_token and linkbox's token are also set by
// the user, but other backends use the same names for session keys, so handling them would need
// a rule for each backend type.
var userTokenKeys = []string{"access_token", "app_token", "bearer_token", "bearer_token_command", "permanent_token", "session_token", "token_url"}

// isTokenKey reports whether a key holds sign-in session data rather than something the user
// set. That is token (oauthutil), a key with "token" in its name (token_expiry, trust_token,
// web_token, …), or one of sessionKeys, but never one of userTokenKeys.
func isTokenKey(k string) bool {
	if slices.Contains(userTokenKeys, k) {
		return false
	}
	return slices.Contains(strings.Split(k, "_"), "token") || slices.Contains(sessionKeys, k)
}

// WrappersOf returns names plus every remote whose options refer to one of them (alias, crypt,
// union, combine, …). It repeats this for the remotes it finds until no more are found. The
// result is sorted, with no duplicates. It is used because a change to a remote affects every
// remote built on top of it.
func WrappersOf(conf map[string]map[string]string, names []string) []string {
	set := map[string]bool{}
	for _, n := range names {
		if n != "" {
			set[n] = true
		}
	}
	for grew := true; grew; {
		grew = false
		for remote, opts := range conf {
			if set[remote] {
				continue
			}
			for _, v := range opts {
				if namesAny(v, set) {
					set[remote] = true
					grew = true
					break
				}
			}
		}
	}
	return slices.Sorted(maps.Keys(set))
}

// Mentions reports whether a mount's or serve's source uses one of the remotes in names. That is
// the remote it names, with or without options ("drive:x", "drive,opt=v:x"), or a remote named
// inside it, as in a connection string (":union,upstreams='drive: other:':"). Names should
// include the remotes that wrap a changed one (WrappersOf), so a source that opens a remote
// through another counts too.
func Mentions(source string, names []string) bool {
	set := map[string]bool{}
	for _, n := range names {
		if n != "" {
			set[n] = true
		}
	}
	if len(set) == 0 {
		return false
	}
	if p, err := fspath.Parse(source); err == nil && p.Name != "" && set[p.Name] {
		return true
	}
	return namesAny(source, set)
}

// namesAny reports whether an option value refers to one of the remotes ("name:path"), either
// at the start or after a separator. Examples are union's space-separated upstreams and
// combine's "dir=name:path".
func namesAny(value string, set map[string]bool) bool {
	for name := range set {
		ref := name + ":"
		for i := 0; ; {
			j := strings.Index(value[i:], ref)
			if j < 0 {
				break
			}
			at := i + j
			if at == 0 || strings.ContainsRune(" \t=\"',", rune(value[at-1])) {
				return true
			}
			i = at + 1
		}
	}
	return false
}

// ConfigMap returns the active config, by remote and key, as it was last loaded or saved.
func (s *Store) ConfigMap() map[string]map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]map[string]string, len(s.snap))
	for k, v := range s.snap {
		out[k] = maps.Clone(v)
	}
	return out
}

// The config.Storage methods below call rclone's storage for the loaded file, or act as an
// empty config while no file is loaded.

func (s *Store) cur() *configfile.Storage { return s.inner.Load() }

// reading keeps the config path from changing during one of rclone's accesses to the loaded
// file.
func (s *Store) reading() func() {
	s.pathMu.RLock()
	return s.pathMu.RUnlock
}

func (s *Store) GetSectionList() []string {
	defer s.reading()()
	if in := s.cur(); in != nil {
		return in.GetSectionList()
	}
	return nil
}

func (s *Store) HasSection(section string) bool {
	defer s.reading()()
	in := s.cur()
	return in != nil && in.HasSection(section)
}

func (s *Store) DeleteSection(section string) {
	defer s.reading()()
	if in := s.cur(); in != nil {
		in.DeleteSection(section)
	}
}

func (s *Store) GetKeyList(section string) []string {
	defer s.reading()()
	if in := s.cur(); in != nil {
		return in.GetKeyList(section)
	}
	return nil
}

func (s *Store) GetValue(section, key string) (string, bool) {
	defer s.reading()()
	if in := s.cur(); in != nil {
		return in.GetValue(section, key)
	}
	return "", false
}

// SetValue implements config.Storage. While no file is loaded, the value is discarded, because
// it couldn't be saved.
func (s *Store) SetValue(section, key, value string) {
	defer s.reading()()
	if in := s.cur(); in != nil {
		in.SetValue(section, key, value)
	}
}

func (s *Store) DeleteKey(section, key string) bool {
	defer s.reading()()
	in := s.cur()
	return in != nil && in.DeleteKey(section, key)
}

func (s *Store) Serialize() (string, error) {
	defer s.reading()()
	if in := s.cur(); in != nil {
		return in.Serialize()
	}
	return "", nil
}

// Load implements config.Storage. It never fails, because an error would make LoadedData end the
// process. When LoadedData calls Load right after Open, it reuses the load that Open did.
func (s *Store) Load() error {
	s.mu.Lock()
	if s.fresh {
		s.fresh = false
		s.mu.Unlock()
		return nil
	}
	old := s.state
	s.load(false)
	st := s.state
	s.mu.Unlock()
	if st != old {
		s.notifyState(st)
	}
	return nil
}

// Save implements config.Storage. While the file isn't loaded, the save is refused, because it
// would write an empty config over the file. In that case Save returns nil, since SaveConfig
// would only retry, and State explains why. When the write fails, Save returns the error so
// that SaveConfig retries, and keeps it in State. If the file changed outside the app since it
// was read, Save reads it again first and reports the change to OnChange, as Watch would have.
func (s *Store) Save() error {
	s.mu.Lock()
	old, before := s.state, s.snap
	outside := !s.stamp.equal(stampOf(s.path))
	changed := false
	if outside && s.state.Status == StatusOK {
		// rclone rereads a file that changed outside on its next access (configfile.go:34-49).
		// When that fails, it keeps its old copy, and drops its key if the file didn't decrypt
		// (crypt.go:175-177). Its save would then write that old copy over the change, in
		// plain text, for example after a password was changed or set in a terminal. And a
		// plain file read while the key is still held would be encrypted again with the old
		// password. So the file is read here, as Poll would have read it, and saved only if
		// the read succeeds. The copy that gets saved is rclone's, because it has both the
		// change that rclone read and the edit that this save is for.
		held := s.cur()
		s.load(true)
		if s.state.Status == StatusOK {
			s.inner.Store(held)
		}
		changed = true
	}
	if s.state.Status != StatusOK {
		// i18n: The config file's path, then its state: needs_password or error.
		why := i18n.M("the config file %s is not loaded (%s)", s.path, s.state.Status)
		if changed {
			// i18n: The config file's path, then its state: needs_password or error.
			why = i18n.M("the config file %s changed outside the app and can't be read (%s)", s.path, s.state.Status)
		}
		s.state.SaveError = i18n.SaveText(why)
		st := s.state
		s.mu.Unlock()
		if st != old {
			s.notifyState(st)
		}
		return nil
	}
	in := s.cur()
	s.pathMu.RLock()
	err := in.Save()
	s.pathMu.RUnlock()
	var ch *Change
	if err != nil {
		s.state.SaveError = i18n.Save(err)
	} else {
		s.state.SaveError = ""
		s.state.Encrypted = config.IsEncrypted()
		s.state.Keyed = s.state.Encrypted
		s.snap, s.stamp = snapshot(in), stampOf(s.path)
		if outside {
			ch = s.change(before, s.snap)
		}
	}
	st := s.state
	s.mu.Unlock()
	if st != old {
		s.notifyState(st)
	}
	if ch != nil {
		s.notifyChange(*ch)
	}
	return err
}

var _ config.Storage = (*Store)(nil)

// encryptHeader is the line an encrypted config file starts with (fs/config/crypt.go:75, 225).
const encryptHeader = "RCLONE_ENCRYPT_V0:"

// ErrWrongPassword is returned by CheckPassword for a password that doesn't open the file. It
// rejects the password field of the form that asked for it.
var ErrWrongPassword = errs.Field("password", "That password doesn't open the config.")

// ErrNotEncrypted is returned by CheckPassword for a file without an encryption header.
var ErrNotEncrypted = errs.Precondition("the config file is not encrypted")

// IsEncrypted reports whether the file at path is an encrypted rclone config. That is the case
// when its first line that isn't blank or a comment is the encryption header, which is how
// rclone's Decrypt reads it (crypt.go:57-86). It returns false for a missing or unreadable file.
func IsEncrypted(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	_, err = afterHeader(bufio.NewReader(f))
	return err == nil
}

// afterHeader reads r up to the encryption header and returns what follows it. It returns
// ErrNotEncrypted when the first meaningful line is something else.
func afterHeader(r *bufio.Reader) (*bufio.Reader, error) {
	for {
		line, _, err := r.ReadLine()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, ErrNotEncrypted
			}
			return nil, err
		}
		l := strings.TrimSpace(string(line))
		if l == "" || strings.HasPrefix(l, ";") || strings.HasPrefix(l, "#") {
			continue
		}
		if l == encryptHeader {
			return r, nil
		}
		if strings.HasPrefix(l, "RCLONE_ENCRYPT_V") {
			return nil, errors.New("unsupported configuration encryption - update rclone for support")
		}
		return nil, ErrNotEncrypted
	}
}

// CheckPassword reports whether password opens the encrypted config file at path. It returns
// nil, ErrWrongPassword, or ErrNotEncrypted for a file without a password. It decrypts a copy
// of the file (see decrypt) without touching rclone's global key. config.Decrypt only tries the
// key that is already set, and clears it if it is wrong (crypt.go:175-177), which would change
// how the active file is saved.
func CheckPassword(path, password string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	_, err = decrypt(b, password)
	return err
}

// configKey is the key rclone derives from a config password (crypt.go:273-290). It refuses the
// passwords that rclone refuses, in rclone's words, on the password field like ErrWrongPassword.
func configKey(password string) (key [32]byte, err error) {
	if !utf8.ValidString(password) {
		return key, errs.Field("password", "password contains invalid utf8 characters")
	}
	if strings.TrimSpace(password) == "" {
		return key, errs.Field("password", "no characters in password")
	}
	return sha256.Sum256([]byte("[" + norm.NFKC.String(password) + "][rclone-config]")), nil
}

// defaultPath is the app's config file. It is read once, before the app points rclone at the
// config that the app uses.
var defaultPath struct {
	once sync.Once
	path string
	// rclones is true when path is rclone's own default, which any rclone finds without --config.
	rclones bool
	err     error
}

// PortableConfig returns a portable copy's config file: rclone.conf in the copy's folder
// (datadir.Portable), whether or not the file exists yet. ok is false outside a portable copy.
// rclone itself only prefers an rclone.conf next to its executable when the file exists, and it
// decides at init, so a new portable copy would otherwise write its first remote to %APPDATA%.
func PortableConfig() (path string, ok bool) {
	root, ok := datadir.Portable()
	if !ok {
		return "", false
	}
	return filepath.Join(root, "rclone.conf"), true
}

// EnsurePortableConfig creates a portable copy's rclone.conf, empty, when it doesn't exist yet. It
// does nothing outside a portable copy. rclone's init looks for an rclone.conf next to its
// executable first, but only uses one that exists. Without it, init creates the folder for a new
// config in %APPDATA%, before any of the app's code runs. Once the file exists, no later start of
// this copy touches %APPDATA%.
func EnsurePortableConfig() error {
	path, ok := PortableConfig()
	if !ok {
		return nil
	}
	return createEmpty(path)
}

func createEmpty(path string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return f.Close()
}

// DefaultConfigPath returns the app's config file. In a portable copy, that is PortableConfig.
// Otherwise it is the file rclone chose at init (fs/config's makeConfigPath). rclone looks next
// to the executable, in %APPDATA%, $XDG_CONFIG_HOME, ~/.config/rclone or the legacy
// ~/.rclone.conf, and otherwise picks the place where it would create one. RCLONE_CONFIG is
// ignored, because the app parses none of rclone's flags, so rclone never reads the variable
// here. The app therefore opens the same file however it is started. Init calls this before it
// sets the app's own config path, so the result is still rclone's choice when it is asked for
// later.
func DefaultConfigPath() (string, error) {
	defaultPath.once.Do(func() {
		defaultPath.path, defaultPath.rclones, defaultPath.err = defaultConfig(PortableConfig, config.GetConfigPath)
	})
	return defaultPath.path, defaultPath.err
}

// defaultConfig is DefaultConfigPath's rule. portable is PortableConfig, and chosen returns the
// file that rclone chose at init. rclones is true when path is rclone's own choice.
func defaultConfig(portable func() (string, bool), chosen func() string) (path string, rclones bool, err error) {
	if p, ok := portable(); ok {
		return p, false, nil
	}
	p := chosen()
	if p == "" {
		return "", false, errors.New("rclone has no config file")
	}
	if p, err = filepath.Abs(p); err != nil {
		return "", false, err
	}
	return p, true, nil
}

// ScriptConfig returns the config file that a command in a script must name with --config: the
// active one, or "" when it is rclone's own default config file, which rclone finds by itself. A
// portable copy's file is always named, because only that copy's rclone looks for it.
func ScriptConfig() string {
	path := config.GetConfigPath()
	def, err := DefaultConfigPath()
	if path == "" || err == nil && defaultPath.rclones && filepath.Clean(path) == def {
		return ""
	}
	return path
}
