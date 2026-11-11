// Package config manages the app's rclone config file. It is rclone's default file, or the
// rclone.conf in a portable copy's folder (rclone.DefaultConfigPath), and the app's rclone command
// on the PATH uses it too. rclone reads and writes it itself. The app adds its password
// (remembered in the keychain or given by a password command), an editor for its text, and an
// export. rclone's config is shared by the whole process. Mounts, serves and the tunnel's rcd run
// as child processes, each given the file with --config.
package config

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/atomicfile"
	"github.com/rclone/rclone-ui/core/internal/hostenv"
	"github.com/rclone/rclone-ui/core/keychain"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// The errors about the config's password. A wrong password rejects the password field. A
// missing one is a precondition, which a page fixes by asking for the password: the mounts and
// serves return it too, when their rclone can't open the config.
var (
	ErrWrongPassword = rclone.ErrWrongPassword
	ErrNeedsPassword = errs.Precondition("the config is encrypted: enter its password")
	// errPasswordChanged is WriteText's refusal of a password that no longer opens the file.
	errPasswordChanged = errs.Precondition("The config file's password was changed outside the app, so your changes were not saved. Unlock the config with its new password, then save again.")
)

// Secrets stores passwords. It is implemented by core/keychain.
type Secrets interface {
	Get(account string) (string, error)
	Set(account, secret string) error
	Delete(account string) error
}

// defaultPath returns the file the service manages. Tests point it at a file of their own.
var defaultPath = rclone.DefaultConfigPath

type Service struct {
	db      *db.DB
	bus     *bus.Bus
	secrets Secrets

	// op is held for the whole of an Unlock, a password change, a text write and an export. This
	// keeps one of them from running between another's read of the file and its write. Without
	// it, a text write that read the file before it was encrypted could write plain text over the
	// file that a password change had just encrypted.
	op sync.Mutex

	mu sync.Mutex
	// path is the file, set by Prepare.
	path  string
	store *rclone.Store
	// inUse is Options.InUse.
	inUse func() []i18n.Text
	// unlocked is called when the locked file is unlocked. Anything known about the remotes
	// before that is no longer valid.
	unlocked []func()
	// password is the password learned during this run, or "". Children are given it.
	password string
	// unsaved is why a password that the user asked to remember couldn't be saved to the
	// keychain, as i18n.SaveText writes it. Get shows it (SaveError) until the password is saved,
	// forgotten, or no longer meant to be remembered.
	unsaved string
}

type Options struct {
	// DB keeps the password command.
	DB      *db.DB
	Bus     *bus.Bus
	Secrets Secrets
	// InUse names the children (mounts, serves, the tunnel) that run on the file. While any run,
	// its password can't be changed. It is called during a password change, so it must not call
	// the service. nil means none.
	InUse func() []i18n.Text
}

// New returns the Service. It reads nothing until Prepare.
func New(o Options) *Service {
	return &Service{db: o.DB, bus: o.Bus, secrets: o.Secrets, inUse: o.InUse}
}

// OnUnlocked adds fn to the functions called after Unlock opens the locked file.
func (s *Service) OnUnlocked(fn func()) {
	s.mu.Lock()
	s.unlocked = append(s.unlocked, fn)
	s.mu.Unlock()
}

// Prepare finds the file and runs before rclone's init. It returns the file's path and its
// password, or "" when no password is known.
func (s *Service) Prepare(ctx context.Context) (path, password string, err error) {
	path, err = defaultPath()
	if err != nil {
		return "", "", err
	}
	s.mu.Lock()
	s.path = path
	s.mu.Unlock()
	return path, s.knownPassword(ctx), nil
}

// Attach gives the service rclone's store, once rclone's init has opened the file.
func (s *Service) Attach(store *rclone.Store) {
	s.mu.Lock()
	s.store = store
	s.mu.Unlock()
}

// Locked reports whether the file is encrypted and still waits for its password.
func (s *Service) Locked() bool {
	s.mu.Lock()
	store := s.store
	s.mu.Unlock()
	return store != nil && store.State().Status == rclone.StatusNeedsPassword
}

func (s *Service) Path() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.path
}

// passwordCommand returns the file's password command, or "".
func (s *Service) passwordCommand(ctx context.Context) (string, error) {
	var command string
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT password_command FROM config WHERE id = 1`).Scan(&command)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	})
	return command, err
}

// knownPassword returns the file's password if the app can find it without asking the user. It
// looks in the password from this run, then the keychain, then the password command. It
// remembers what it finds for the rest of the run.
func (s *Service) knownPassword(ctx context.Context) string {
	s.mu.Lock()
	path, pw := s.path, s.password
	s.mu.Unlock()
	if pw != "" || !rclone.IsEncrypted(path) {
		return pw
	}
	if v, err := s.secrets.Get(keychain.ConfigAccount(path)); err == nil && v != "" && rclone.CheckPassword(path, v) == nil {
		pw = v
	} else if command, err := s.passwordCommand(ctx); err == nil && command != "" {
		if v, err := runPasswordCommand(ctx, command); err == nil && rclone.CheckPassword(path, v) == nil {
			pw = v
		}
	}
	if pw != "" {
		s.mu.Lock()
		s.password = pw
		s.mu.Unlock()
	}
	return pw
}

// runPasswordCommand runs a password command as rclone's --password-command does. The command
// line is split on spaces, with quotes grouping words, and its output is the password.
func runPasswordCommand(ctx context.Context, command string) (string, error) {
	var args fs.SpaceSepList
	if err := args.Set(command); err != nil || len(args) == 0 {
		return "", fmt.Errorf("the password command %q can't be read", command)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := hostenv.Command(ctx, args[0], args[1:]...).Output()
	if err != nil {
		return "", fmt.Errorf("the password command failed: %w", err)
	}
	pw := strings.Trim(string(out), "\r\n")
	if pw == "" {
		return "", errors.New("the password command returned nothing")
	}
	return pw, nil
}

func (s *Service) Get(ctx context.Context) (*ConfigFile, error) {
	command, err := s.passwordCommand(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	path, store, unsaved := s.path, s.store, s.unsaved
	s.mu.Unlock()
	c := &ConfigFile{Path: path, PasswordCommand: command}
	describeFile(c, store)
	if unsaved != "" && c.SaveError == "" {
		c.setSaveError(i18n.Saved(unsaved))
	}
	// The keychain is checked last, and only for an encrypted file, because a keychain may ask
	// the user each time. The result isn't cached, because the account can be changed in
	// Keychain Access at any time.
	if c.Encrypted {
		if v, err := s.secrets.Get(keychain.ConfigAccount(path)); err == nil && v != "" {
			c.PasswordSaved = true
		}
	}
	return c, nil
}

// describeFile fills in the file's state from rclone's store, including its save error.
func describeFile(c *ConfigFile, store *rclone.Store) {
	if store == nil || !SameFile(store.Path(), c.Path) {
		if _, err := os.Stat(c.Path); errors.Is(err, os.ErrNotExist) {
			c.Status = StatusMissing
			return
		} else if err != nil {
			c.Status = StatusError
			c.setMessage(i18n.Saved(i18n.Save(err)))
			return
		}
		c.Encrypted = rclone.IsEncrypted(c.Path)
		c.Status = StatusOK
		return
	}
	st := store.State()
	c.Encrypted = st.Encrypted
	c.setMessage(i18n.Saved(st.Message))
	if st.SaveError != "" {
		// i18n: Why rclone's last save of the config file failed.
		c.setSaveError(i18n.M("not saved: %s", i18n.Saved(st.SaveError)))
	}
	switch st.Status {
	case rclone.StatusOK:
		c.Status = StatusOK
	case rclone.StatusNeedsPassword:
		c.Status = StatusNeedsPassword
	default:
		c.Status = StatusError
	}
	if _, err := os.Stat(c.Path); errors.Is(err, os.ErrNotExist) && c.Status == StatusOK {
		c.Status = StatusMissing
	}
}

// SameFile reports whether a and b refer to the same file. That is the case when the cleaned
// paths are equal, or when both paths lead to the same existing file (through a link or a
// different spelling).
func SameFile(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	ia, errA := os.Stat(a)
	ib, errB := os.Stat(b)
	return errA == nil && errB == nil && os.SameFile(ia, ib)
}

// writeAtomic replaces a file's contents with a single rename, and keeps the file's mode because
// the file belongs to the user. A link is followed, so the rename replaces its target and the
// link stays in place, as it does when rclone saves the file itself.
func writeAtomic(path string, data []byte) error {
	if target, err := filepath.EvalSymlinks(path); err == nil {
		path = target
	}
	mode := os.FileMode(0o600)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	return atomicfile.WriteFile(path, data, mode)
}

func (s *Service) changed() { s.bus.Publish(bus.ConfigChanged, nil) }

// SetPasswordCommand sets the command that gives the file's password, or removes it when
// command is "".
func (s *Service) SetPasswordCommand(ctx context.Context, command string) (*ConfigFile, error) {
	command = strings.TrimSpace(command)
	if command != "" {
		var args fs.SpaceSepList
		if err := args.Set(command); err != nil || len(args) == 0 {
			return nil, errs.Field("passwordCommand", "That command can't be read.")
		}
	}
	if err := s.db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO config (id, password_command) VALUES (1, ?)
			ON CONFLICT (id) DO UPDATE SET password_command = excluded.password_command`, command)
		return err
	}); err != nil {
		return nil, err
	}
	s.changed()
	return s.Get(ctx)
}

// rememberPassword keeps the password for this run, and also saves it in the keychain when keep
// is set. If the keychain refuses it, the action that was done still stands, because the file is
// already open. The failure is logged and shown by Get (SaveError), in the words that unsaved
// gives for the keychain's error.
func (s *Service) rememberPassword(path, password string, keep bool, unsaved func(err error) i18n.Text) {
	var why string
	if keep {
		if err := s.secrets.Set(keychain.ConfigAccount(path), password); err != nil {
			logs.Logger(logs.CompConfig, "").Error("saving the config's password to the keychain", "path", path, "error", err)
			why = i18n.SaveText(unsaved(err))
		}
	}
	s.mu.Lock()
	s.password = password
	s.unsaved = why
	s.mu.Unlock()
}

// ForgetPassword takes the file's password out of the keychain. The password is still kept for
// this run, because the open file and its children still need it.
func (s *Service) ForgetPassword(ctx context.Context) (*ConfigFile, error) {
	// A missing password is not an error, because the keychain ends up as requested either way.
	_ = s.secrets.Delete(keychain.ConfigAccount(s.Path()))
	s.mu.Lock()
	s.unsaved = ""
	s.mu.Unlock()
	s.changed()
	return s.Get(ctx)
}

// Unlock opens the file with password. When the file is already open, it only remembers the
// password.
func (s *Service) Unlock(ctx context.Context, password string, remember bool) (*ConfigFile, error) {
	s.op.Lock()
	defer s.op.Unlock()
	s.mu.Lock()
	path, store := s.path, s.store
	s.mu.Unlock()
	if err := rclone.CheckPassword(path, password); err != nil {
		return nil, err
	}
	s.rememberPassword(path, password, remember, func(err error) i18n.Text {
		// i18n: The value is the keychain's error.
		return i18n.M("Unlocked, but the password couldn't be saved to the keychain: %s", err)
	})
	if store.State().Status == rclone.StatusOK && SameFile(store.Path(), path) {
		// The file is already open.
		s.changed()
		return s.Get(ctx)
	}
	if err := store.Open(path, password); err != nil {
		return nil, err
	}
	s.mu.Lock()
	fns := s.unlocked
	s.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
	s.changed()
	return s.Get(ctx)
}

// SetPassword encrypts the file with password, or changes its password. The encrypted file is
// written first, and then rclone opens it with the new key, as Unlock does. If the write fails,
// the file, rclone's key and the saved password stay as they were. The same is true when rclone
// saves the file between those two steps (see rekeyRaced). The change is refused while a child
// runs on the file. The child keeps the key it started with, so its next save (after a token
// refresh, for example) would write the file under the old key again, or in plain text.
func (s *Service) SetPassword(ctx context.Context, password string, remember bool) (*ConfigFile, error) {
	s.op.Lock()
	defer s.op.Unlock()
	path, store, err := s.rekeyable(ctx)
	if err != nil {
		return nil, err
	}
	old := s.runPassword()
	plain, err := store.Serialize()
	if err != nil {
		return nil, err
	}
	// A password that rclone refuses is refused on the password field.
	data, err := rclone.EncryptConfig([]byte(plain), password)
	if err != nil {
		return nil, err
	}
	if err := rekeyWrite(path, data); err != nil {
		// i18n: The value is the error of the file's write, often the system's, in English.
		return nil, errs.Said(errs.CodeFailed, i18n.M("the config wasn't saved, and its password is unchanged: %s", err))
	}
	// The OnUnlocked functions aren't called, because the remotes haven't changed.
	if err := store.Open(path, password); err != nil {
		return nil, err
	}
	// Open loads an encrypted file only with the password it was given.
	if st := store.State(); st.Status != rclone.StatusOK || !st.Encrypted {
		return nil, rekeyRaced(store, path, old)
	}
	_ = s.secrets.Delete(keychain.ConfigAccount(path))
	s.rememberPassword(path, password, remember, func(err error) i18n.Text {
		// i18n: The value is the keychain's error.
		return i18n.M("The password was set, but the password couldn't be saved to the keychain: %s", err)
	})
	s.changed()
	return s.Get(ctx)
}

// RemovePassword saves the file unencrypted. It is refused in the same cases as SetPassword. The
// plain file is written first. The password is removed from this run and from the keychain only
// after rclone has opened the file without one.
func (s *Service) RemovePassword(ctx context.Context) (*ConfigFile, error) {
	s.op.Lock()
	defer s.op.Unlock()
	path, store, err := s.rekeyable(ctx)
	if err != nil {
		return nil, err
	}
	old := s.runPassword()
	plain, err := store.Serialize()
	if err != nil {
		return nil, err
	}
	if err := rekeyWrite(path, []byte(plain)); err != nil {
		// i18n: The value is the error of the file's write, often the system's, in English.
		return nil, errs.Said(errs.CodeFailed, i18n.M("the config wasn't saved, and its password is unchanged: %s", err))
	}
	if err := store.Open(path, ""); err != nil {
		return nil, err
	}
	if st := store.State(); st.Status != rclone.StatusOK || st.Encrypted {
		return nil, rekeyRaced(store, path, old)
	}
	s.mu.Lock()
	s.password, s.unsaved = "", ""
	s.mu.Unlock()
	_ = s.secrets.Delete(keychain.ConfigAccount(path))
	s.changed()
	return s.Get(ctx)
}

// StateChanged is called when the file's state changes (rclone.Store's OnState). Suppose rclone
// has the file open, in plain text, with no key held, while this run knows a password for it.
// Then its password was removed outside the app, and the store dropped its key when it reloaded
// the file. In that case the password is removed from this run and from the keychain, as
// RemovePassword does. A file that was emptied keeps its key, so its password is kept too.
func (s *Service) StateChanged(st rclone.State) {
	if st.Status != rclone.StatusOK || st.Encrypted || st.Keyed {
		return
	}
	s.mu.Lock()
	path, known := s.path, s.password != ""
	if known && SameFile(path, st.Path) {
		s.password, s.unsaved = "", ""
	} else {
		known = false
	}
	s.mu.Unlock()
	if known {
		_ = s.secrets.Delete(keychain.ConfigAccount(path))
	}
}

// rekeyWrite writes the file with the new password (writeAtomic). It is a variable so that a test
// can follow it with a save by rclone, as a token refresh during a transfer could.
var rekeyWrite = writeAtomic

// errRekeyRaced means a password change didn't take effect. rclone saved the file after the new
// file was written but before rclone opened it with the new key, so the file was saved under
// the old key, or without one.
var errRekeyRaced = errs.Said(errs.CodeFailed, i18n.M("the config was saved with an old password while the password changed (a sign-in refreshing), so its password is unchanged: try again"))

// rekeyRaced opens the file again with the password it still has, and returns errRekeyRaced.
// old is this run's password, or "" when there is none or it comes from RCLONE_CONFIG_PASS. The
// saved and known passwords are unchanged.
func rekeyRaced(store *rclone.Store, path, old string) error {
	if err := store.Open(path, old); err != nil {
		return fmt.Errorf("%w (reopening it: %w)", errRekeyRaced, err)
	}
	return errRekeyRaced
}

func (s *Service) runPassword() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.password
}

// rekeyable returns the file's path and rclone's store, so that its password can be changed. The
// caller holds s.op. It refuses a file that rclone hasn't loaded, because its text would be lost,
// and a file that a child runs on.
func (s *Service) rekeyable(ctx context.Context) (string, *rclone.Store, error) {
	c, err := s.Get(ctx)
	if err != nil {
		return "", nil, err
	}
	switch c.Status {
	case StatusNeedsPassword:
		return "", nil, ErrNeedsPassword
	case StatusError:
		// i18n: The value is the reason, often in rclone's words.
		return "", nil, errs.Errorf("The config file can't be read, so its password can't change: %s", c.message)
	}
	s.mu.Lock()
	store := s.store
	s.mu.Unlock()
	if s.inUse != nil {
		if what := s.inUse(); len(what) > 0 {
			// i18n: The value lists the mounts, serves and other things that use the config file.
			return "", nil, errs.Errorf("Stop these first. They use this config and would undo the change: %s", list(what))
		}
	}
	return c.Path, store, nil
}

// ReadText returns the file's text, decrypted with the password the app knows for it.
func (s *Service) ReadText(ctx context.Context) (string, error) {
	path := s.Path()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !rclone.IsEncrypted(path) {
		return string(data), nil
	}
	pw := s.knownPassword(ctx)
	if pw == "" {
		return "", ErrNeedsPassword
	}
	plain, err := rclone.DecryptConfig(data, pw)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// WriteText replaces the file's text atomically, once CheckText accepts it. If the file is
// encrypted, the new text is encrypted with its password. The check runs under s.op, so it sees
// the file's current state. rclone reads the file again through the watcher.
//
// A password that no longer opens the file was changed outside the app. Writing with it would
// undo that change, so nothing is written, and this run forgets it (errPasswordChanged).
func (s *Service) WriteText(ctx context.Context, text string) error {
	if err := CheckText(text); err != nil {
		return err
	}
	s.op.Lock()
	defer s.op.Unlock()
	path := s.Path()
	data := []byte(text)
	if rclone.IsEncrypted(path) {
		pw := s.knownPassword(ctx)
		if pw == "" {
			return ErrNeedsPassword
		}
		if rclone.CheckPassword(path, pw) != nil {
			s.mu.Lock()
			if s.password == pw {
				s.password = ""
			}
			s.mu.Unlock()
			return errPasswordChanged
		}
		var err error
		if data, err = rclone.EncryptConfig(data, pw); err != nil {
			return err
		}
	}
	if err := writeAtomic(path, data); err != nil {
		return err
	}
	s.mu.Lock()
	store := s.store
	s.mu.Unlock()
	if store != nil && SameFile(store.Path(), path) {
		store.Poll()
	}
	return nil
}

// Export copies the file, as it is on disk, to path. path can't be the file itself, because the
// copy would start by emptying it.
func (s *Service) Export(ctx context.Context, path string) error {
	s.op.Lock()
	defer s.op.Unlock()
	own := s.Path()
	if SameFile(own, path) {
		return errs.Field("path", "That's the config file itself. Choose another file.")
	}
	data, err := os.ReadFile(own)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(path, data, 0o600)
}

// ChildPassword returns the password that a child rclone (a mount, a serve, the tunnel) needs
// for the file. It returns "" for a plain file, and ErrNeedsPassword when the file is encrypted
// and no password is known. The supervisor passes it to the child in a one-time key file, never
// in the environment or the arguments.
func (s *Service) ChildPassword(ctx context.Context) (string, error) {
	if !rclone.IsEncrypted(s.Path()) {
		return "", nil
	}
	if pw := s.knownPassword(ctx); pw != "" {
		return pw, nil
	}
	return "", ErrNeedsPassword
}

// list joins items into one text, in the order given, with the separator of the app's language.
func list(items []i18n.Text) i18n.Text {
	if len(items) == 0 {
		return i18n.Text{}
	}
	out := items[0]
	for _, it := range items[1:] {
		// i18n: Joins two items of a list, as in "Mount gdrive: at /mnt, Serve photos: over HTTP".
		out = i18n.M("%s, %s", out, it)
	}
	return out
}
