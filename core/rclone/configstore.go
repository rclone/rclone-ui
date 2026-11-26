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

// Store handles two things that rclone doesn't handle in a long-lived process:
//
//   - A load never fails. rclone's LoadedData calls Fatalf when Load returns an error
//     (fs/config/config.go:361-382), so a wrong password or a broken file would end the app.
//     The Store loads what it can and reports the result in State: ok, needs a password, or
//     an error.
//   - A failed save is remembered. rclone's SaveConfig only logs a failure after its retries
//     (config.go:386-398). State keeps the error until a save succeeds. While the file isn't
//     loaded, a save is refused rather than attempted, because it would replace the file with
//     an empty one.

type Status string

const (
	StatusOK            Status = "ok"
	StatusNeedsPassword Status = "needs-password"
	StatusError         Status = "error"
)

type State struct {
	Path      string
	Status    Status
	Encrypted bool
	Keyed     bool
	Message   string
	SaveError string
}

type Change struct {
	Sections []string
}

const watchEvery = 2 * time.Second

type Store struct {
	mu        sync.Mutex
	inner     atomic.Pointer[configfile.Storage]
	path      string
	password  bool
	fresh     bool
	installed bool
	state     State
	stamp     stamp
	snap      map[string]map[string]string
	vanished  bool

	// pathMu guards rclone's config path. That path is a plain global (config.SetConfigPath)
	// which configfile.Storage reads on every access, and Open changes it while a health check or
	// a listing may still be reading the old file.
	pathMu sync.RWMutex

	hooks sync.Mutex
	onCh  func(Change)
	onSt  func(State)
}

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

func NewStore() *Store { return &Store{} }

func (s *Store) OnChange(fn func(Change)) {
	s.hooks.Lock()
	defer s.hooks.Unlock()
	s.onCh = fn
}

func (s *Store) OnState(fn func(State)) {
	s.hooks.Lock()
	defer s.hooks.Unlock()
	s.onSt = fn
}

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

// The failed configfile.Storage isn't kept, because it would try again, and log, on every access
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

func isTokenKey(k string) bool {
	if slices.Contains(userTokenKeys, k) {
		return false
	}
	return slices.Contains(strings.Split(k, "_"), "token") || slices.Contains(sessionKeys, k)
}

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

func (s *Store) ConfigMap() map[string]map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]map[string]string, len(s.snap))
	for k, v := range s.snap {
		out[k] = maps.Clone(v)
	}
	return out
}

func (s *Store) cur() *configfile.Storage { return s.inner.Load() }

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
// process.
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
		// password.
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

const encryptHeader = "RCLONE_ENCRYPT_V0:"

var ErrWrongPassword = errs.Field("password", "That password doesn't open the config.")

var ErrNotEncrypted = errs.Precondition("the config file is not encrypted")

func IsEncrypted(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	_, err = afterHeader(bufio.NewReader(f))
	return err == nil
}

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

// config.Decrypt isn't used: it only tries the key that is already set, and clears it if it is
// wrong (crypt.go:175-177), which would change how the active file is saved.
func CheckPassword(path, password string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	_, err = decrypt(b, password)
	return err
}

// configKey is the key rclone derives from a config password (crypt.go:273-290).
func configKey(password string) (key [32]byte, err error) {
	if !utf8.ValidString(password) {
		return key, errs.Field("password", "password contains invalid utf8 characters")
	}
	if strings.TrimSpace(password) == "" {
		return key, errs.Field("password", "no characters in password")
	}
	return sha256.Sum256([]byte("[" + norm.NFKC.String(password) + "][rclone-config]")), nil
}

var defaultPath struct {
	once    sync.Once
	path    string
	rclones bool
	err     error
}

// rclone itself only prefers an rclone.conf next to its executable when the file exists, and it
// decides at init, so a new portable copy would otherwise write its first remote to %APPDATA%.
func PortableConfig() (path string, ok bool) {
	root, ok := datadir.Portable()
	if !ok {
		return "", false
	}
	return filepath.Join(root, "rclone.conf"), true
}

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

func DefaultConfigPath() (string, error) {
	defaultPath.once.Do(func() {
		defaultPath.path, defaultPath.rclones, defaultPath.err = defaultConfig(PortableConfig, config.GetConfigPath)
	})
	return defaultPath.path, defaultPath.err
}

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

func ScriptConfig() string {
	path := config.GetConfigPath()
	def, err := DefaultConfigPath()
	if path == "" || err == nil && defaultPath.rclones && filepath.Clean(path) == def {
		return ""
	}
	return path
}
