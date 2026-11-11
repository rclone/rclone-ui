package config

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/memory"
	rcloneconfig "github.com/rclone/rclone/fs/config"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/keychain"
	"github.com/rclone/rclone-ui/core/rclone"
)

// Every test shares one rclone, as the core does, because rclone's config is process-wide.
var (
	store       *rclone.Store
	defaultConf string // rclone's default file for the tests ($XDG_CONFIG_HOME/rclone/rclone.conf)
)

func TestMain(m *testing.M) {
	testutil.Main(m, func(dir string) error {
		configDir := filepath.Join(dir, "rclone") // Home sets XDG_CONFIG_HOME to dir
		if err := os.MkdirAll(configDir, 0o700); err != nil {
			return err
		}
		defaultConf = filepath.Join(configDir, "rclone.conf")
		if err := os.WriteFile(defaultConf, []byte("[mem]\ntype = memory\n"), 0o600); err != nil {
			return err
		}
		var err error
		store, err = rclone.Init(context.Background(), rclone.InitOptions{ConfigPath: defaultConf, CacheDir: filepath.Join(dir, "cache")})
		return err
	})
}

type memSecrets map[string]string

func (m memSecrets) Get(a string) (string, error) {
	v, ok := m[a]
	if !ok {
		return "", errors.New("not found")
	}
	return v, nil
}
func (m memSecrets) Set(a, s string) error { m[a] = s; return nil }
func (m memSecrets) Delete(a string) error { delete(m, a); return nil }

// newService returns a service on a fresh database for the file at path. rclone goes back to its
// default file when the test ends.
func newService(t *testing.T, path string, secrets Secrets) *Service {
	t.Helper()
	if secrets == nil {
		secrets = memSecrets{}
	}
	before := defaultPath
	defaultPath = func() (string, error) { return path, nil }
	s := New(Options{DB: testdb.Open(t), Bus: bus.New(), Secrets: secrets})
	t.Cleanup(func() {
		defaultPath = before
		rekeyWrite = writeAtomic
		store.OnState(nil)
		rcloneconfig.ClearConfigPassword()
		if err := store.Open(defaultConf, ""); err != nil {
			t.Error(err)
		}
	})
	return s
}

// start does what the core does at start: Prepare, rclone's open, and Attach.
func start(t *testing.T, s *Service) {
	t.Helper()
	path, pw, err := s.Prepare(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Open(path, pw); err != nil {
		t.Fatal(err)
	}
	s.Attach(store)
}

// writeConfig writes a config file in a folder of its own, encrypted when password isn't "".
func writeConfig(t *testing.T, text, password string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rclone.conf")
	data := []byte(text)
	if password != "" {
		var err error
		if data, err = rclone.EncryptConfig(data, password); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestTheDefaultFile checks that the service manages rclone's default file, and that
// RCLONE_CONFIG doesn't change it.
func TestTheDefaultFile(t *testing.T) {
	t.Setenv("RCLONE_CONFIG", writeConfig(t, "[team]\ntype = memory\n", ""))
	s := New(Options{DB: testdb.Open(t), Bus: bus.New(), Secrets: memSecrets{}})
	path, pw, err := s.Prepare(context.Background())
	if err != nil || path != defaultConf || pw != "" {
		t.Fatalf("Prepare: %q %q %v, want %s", path, pw, err, defaultConf)
	}
	s.Attach(store)
	c, err := s.Get(context.Background())
	if err != nil || c.Path != defaultConf || c.Status != StatusOK || c.Encrypted {
		t.Fatalf("Get: %+v %v", c, err)
	}
}

// TestUnlockAndText checks a locked file: unlocking it, the text editor, the children's password,
// and turning its encryption off and on again.
func TestUnlockAndText(t *testing.T) {
	ctx := context.Background()
	path := writeConfig(t, "[aa]\ntype = memory\n", "s3cret")
	secrets := memSecrets{}
	s := newService(t, path, secrets)
	unlocked := 0
	s.OnUnlocked(func() { unlocked++ })
	start(t, s)

	c, err := s.Get(ctx)
	if err != nil || c.Status != StatusNeedsPassword || !c.Encrypted {
		t.Fatalf("a locked file: %+v %v", c, err)
	}
	if _, err := s.ChildPassword(ctx); !errors.Is(err, ErrNeedsPassword) {
		t.Errorf("a child's password while locked: %v", err)
	}
	if _, err := s.Unlock(ctx, "nope", false); !errors.Is(err, ErrWrongPassword) {
		t.Errorf("a wrong password: %v", err)
	}
	if c, err = s.Unlock(ctx, "s3cret", true); err != nil || c.Status != StatusOK || !c.PasswordSaved {
		t.Fatalf("unlock: %+v %v", c, err)
	}
	if unlocked != 1 || !store.HasSection("aa") {
		t.Errorf("OnUnlocked ran %d times, the remotes read: %v", unlocked, store.HasSection("aa"))
	}
	if secrets[keychain.ConfigAccount(path)] != "s3cret" {
		t.Error("remember didn't keep it")
	}

	// The text editor reads and writes the encrypted file.
	if err := s.WriteText(ctx, "[box]\ntype = memory\n"); err != nil {
		t.Fatal(err)
	}
	if !rclone.IsEncrypted(path) || rclone.CheckPassword(path, "s3cret") != nil {
		t.Error("the write lost the encryption")
	}
	text, err := s.ReadText(ctx)
	if err != nil || !strings.Contains(text, "[box]") {
		t.Errorf("read %q %v", text, err)
	}
	if !store.HasSection("box") {
		t.Error("rclone didn't read the new text")
	}

	// Children get the password (the supervisor writes it to a key file).
	if pw, err := s.ChildPassword(ctx); err != nil || pw != "s3cret" {
		t.Fatalf("child password %q %v", pw, err)
	}

	// Turn encryption off and on again, in the same process.
	if c, err = s.RemovePassword(ctx); err != nil || c.Encrypted || rclone.IsEncrypted(path) {
		t.Fatalf("remove password: %+v %v", c, err)
	}
	if pw, err := s.ChildPassword(ctx); err != nil || pw != "" {
		t.Fatalf("a plain file's child password %q %v", pw, err)
	}
	if c, err = s.SetPassword(ctx, "other", false); err != nil || !c.Encrypted || rclone.CheckPassword(path, "other") != nil {
		t.Fatalf("set password: %+v %v", c, err)
	}
	if unlocked != 1 {
		t.Errorf("a password change ran OnUnlocked (%d)", unlocked)
	}
}

// TestPasswordCommand checks that a password command is stored, that a command that can't be
// read is refused, and that the next start opens the file with the command's output.
func TestPasswordCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the command is echo")
	}
	ctx := context.Background()
	path := writeConfig(t, "[aa]\ntype = memory\n", "s3cret")
	s := newService(t, path, nil)
	if _, err := s.SetPasswordCommand(ctx, `echo "unclosed`); errs.FieldOf(err) != "passwordCommand" {
		t.Errorf("a command that can't be read: %v", err)
	}
	c, err := s.SetPasswordCommand(ctx, "  echo s3cret  ")
	if err != nil || c.PasswordCommand != "echo s3cret" {
		t.Fatalf("SetPasswordCommand: %+v %v", c, err)
	}
	start(t, s)
	if c, err := s.Get(ctx); err != nil || c.Status != StatusOK {
		t.Fatalf("the start with a password command: %+v %v", c, err)
	}
	if c, err := s.SetPasswordCommand(ctx, ""); err != nil || c.PasswordCommand != "" {
		t.Fatalf("removing it: %+v %v", c, err)
	}
}

// TestPasswordChangeRefusedWhileChildrenRun checks that a running child blocks a change of the
// file's password. The child is named in the error, and the file is unchanged.
func TestPasswordChangeRefusedWhileChildrenRun(t *testing.T) {
	ctx := context.Background()
	path := writeConfig(t, "[aa]\ntype = memory\n", "s3cret")
	s := newService(t, path, nil)
	start(t, s)
	if _, err := s.Unlock(ctx, "s3cret", false); err != nil {
		t.Fatal(err)
	}
	const label = "Mount box:photos at /Volumes/photos, The remote tunnel"
	var running []i18n.Text
	s.inUse = func() []i18n.Text { return running } // as Options.InUse

	running = []i18n.Text{i18n.M("Mount %s at %s", "box:photos", "/Volumes/photos"), i18n.M("The remote tunnel")}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func() error{
		"SetPassword":    func() error { _, err := s.SetPassword(ctx, "other", false); return err },
		"RemovePassword": func() error { _, err := s.RemovePassword(ctx); return err },
	} {
		err := change()
		if !errs.Is(err) || !strings.Contains(err.Error(), label) {
			t.Errorf("%s with a mount running: %v", name, err)
		}
		if after, _ := os.ReadFile(path); !bytes.Equal(after, before) {
			t.Errorf("%s changed the file", name)
		}
	}
	if rclone.CheckPassword(path, "s3cret") != nil {
		t.Error("the password changed")
	}

	running = nil
	if _, err := s.SetPassword(ctx, "other", false); err != nil {
		t.Fatalf("with nothing running: %v", err)
	}
	if rclone.CheckPassword(path, "other") != nil {
		t.Error("the new password doesn't open the file")
	}
}

// TestSetPasswordOnAnUnreadableConfig checks that a file rclone can't read can't be encrypted.
// Its text isn't known, so an empty config would replace it.
func TestSetPasswordOnAnUnreadableConfig(t *testing.T) {
	ctx := context.Background()
	const text = "RCLONE_ENCRYPT_V9:\nAAAA\n" // encrypted by a newer rclone
	path := writeConfig(t, text, "")
	s := newService(t, path, nil)
	start(t, s)
	if c, err := s.Get(ctx); err != nil || c.Status != StatusError {
		t.Fatalf("Get: %+v %v", c, err)
	}
	if _, err := s.SetPassword(ctx, "s3cret", false); !errs.Is(err) {
		t.Fatalf("SetPassword on an unreadable file: %v", err)
	}
	if b, _ := os.ReadFile(path); string(b) != text {
		t.Errorf("the file became %q", b)
	}
}

// readOnlyFolder returns a file in a folder, and a function that makes the folder read-only or
// writable again.
func readOnlyFolder(t *testing.T, text, password string) (string, func(bool)) {
	t.Helper()
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a folder this user can't write to")
	}
	path := writeConfig(t, text, password)
	dir := filepath.Dir(path)
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	return path, func(on bool) {
		t.Helper()
		mode := os.FileMode(0o700)
		if on {
			mode = 0o500
		}
		if err := os.Chmod(dir, mode); err != nil {
			t.Fatal(err)
		}
	}
}

// TestPasswordChangeSaveFailsKeepsTheOldKey checks that when the write of a password change
// fails, rclone's key, the keychain and the run's password stay as they were. rclone's next save
// then keeps the file as it was (plain, or under the old password).
func TestPasswordChangeSaveFailsKeepsTheOldKey(t *testing.T) {
	ctx := context.Background()
	t.Run("plain", func(t *testing.T) {
		path, readOnly := readOnlyFolder(t, "[a]\ntype = memory\n", "")
		secrets := memSecrets{}
		s := newService(t, path, secrets)
		start(t, s)
		readOnly(true)
		if _, err := s.SetPassword(ctx, "new", true); err == nil || !strings.Contains(err.Error(), "password is unchanged") {
			t.Fatalf("SetPassword in a read-only folder: %v", err)
		}
		readOnly(false)
		if err := store.Save(); err != nil {
			t.Fatal(err)
		}
		if rclone.IsEncrypted(path) {
			t.Error("rclone's next save encrypted the file")
		}
		if _, ok := secrets[keychain.ConfigAccount(path)]; ok {
			t.Error("the keychain kept the new password")
		}
		if s.runPassword() != "" {
			t.Error("the run kept the new password")
		}
	})
	t.Run("encrypted", func(t *testing.T) {
		path, readOnly := readOnlyFolder(t, "[bb]\ntype = memory\n", "old")
		secrets := memSecrets{}
		s := newService(t, path, secrets)
		start(t, s)
		if c, err := s.Unlock(ctx, "old", true); err != nil || c.Status != StatusOK {
			t.Fatalf("unlock: %+v %v", c, err)
		}
		readOnly(true)
		if _, err := s.RemovePassword(ctx); err == nil || !strings.Contains(err.Error(), "password is unchanged") {
			t.Fatalf("RemovePassword in a read-only folder: %v", err)
		}
		readOnly(false)
		if err := store.Save(); err != nil {
			t.Fatal(err)
		}
		if rclone.CheckPassword(path, "old") != nil {
			t.Error("rclone's next save didn't keep the old password")
		}
		if secrets[keychain.ConfigAccount(path)] != "old" {
			t.Error("the keychain lost the password")
		}
		if pw := s.runPassword(); pw != "old" {
			t.Errorf("the run's password is %q", pw)
		}
	})
}

// TestSavePasswordOnAnOpenConfigDoesntReopen checks that unlocking a config that's already open
// (to save its password) only remembers the password. The remotes aren't told that the file
// opened.
func TestSavePasswordOnAnOpenConfigDoesntReopen(t *testing.T) {
	ctx := context.Background()
	path := writeConfig(t, "[aa]\ntype = memory\n", "s3cret")
	secrets := memSecrets{}
	s := newService(t, path, secrets)
	unlocked := 0
	s.OnUnlocked(func() { unlocked++ })
	start(t, s)
	if c, err := s.Unlock(ctx, "s3cret", false); err != nil || c.Status != StatusOK {
		t.Fatalf("unlock: %+v %v", c, err)
	}
	c, err := s.Unlock(ctx, "s3cret", true)
	if err != nil || c.Status != StatusOK || !c.PasswordSaved {
		t.Fatalf("unlock to save the password: %+v %v", c, err)
	}
	if unlocked != 1 {
		t.Errorf("saving the password reopened the config (%d)", unlocked)
	}
	if secrets[keychain.ConfigAccount(path)] != "s3cret" {
		t.Error("the keychain doesn't hold the password")
	}
	if _, err := s.Unlock(ctx, "nope", true); !errors.Is(err, ErrWrongPassword) {
		t.Errorf("a wrong password on an open config: %v", err)
	}
}

// TestExportOntoItselfIsRefused checks that exporting onto the config file, or onto a link to it,
// is refused and leaves the file unchanged.
func TestExportOntoItselfIsRefused(t *testing.T) {
	ctx := context.Background()
	const text = "[box]\ntype = memory\n"
	path := writeConfig(t, text, "")
	s := newService(t, path, nil)
	start(t, s)
	targets := []string{path}
	if runtime.GOOS != "windows" {
		link := filepath.Join(t.TempDir(), "link.conf")
		if err := os.Symlink(path, link); err != nil {
			t.Fatal(err)
		}
		targets = append(targets, link)
	}
	for _, target := range targets {
		if err := s.Export(ctx, target); errs.FieldOf(err) != "path" {
			t.Errorf("export onto %s: %v", target, err)
		}
		if b, _ := os.ReadFile(path); string(b) != text {
			t.Errorf("export onto %s left the file as %q", target, b)
		}
	}
}

// TestExportWritesACopy checks that the copy holds the file's bytes and replaces the existing
// file.
func TestExportWritesACopy(t *testing.T) {
	ctx := context.Background()
	path := writeConfig(t, "[aa]\ntype = memory\n", "s3cret")
	s := newService(t, path, nil)
	start(t, s)
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "backup.conf")
	if err := os.WriteFile(out, []byte("an older, longer backup that the copy replaces whole"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.Export(ctx, out); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(out); !bytes.Equal(got, want) {
		t.Errorf("the copy is %q, want %q", got, want)
	}
}

// TestWriteTextThroughASymlink checks that the text editor writes to the target of a linked
// config, and that the link stays a link, as it does when rclone saves.
func TestWriteTextThroughASymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need a privilege on Windows")
	}
	ctx := context.Background()
	target := writeConfig(t, "[a]\ntype = memory\n", "")
	link := filepath.Join(t.TempDir(), "rclone.conf")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	s := newService(t, link, nil)
	start(t, s)
	if err := s.WriteText(ctx, "[bb]\ntype = memory\n"); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link became %v, %v", info, err)
	}
	if b, _ := os.ReadFile(target); string(b) != "[bb]\ntype = memory\n" {
		t.Errorf("the target holds %q", b)
	}
}

type countingSecrets struct {
	memSecrets
	gets int
}

func (c *countingSecrets) Get(a string) (string, error) {
	c.gets++
	return c.memSecrets.Get(a)
}

// TestGetAsksTheKeychainOnlyForAnEncryptedFile checks that Get doesn't read the keychain for a
// plain or missing file, because a keychain may ask the user at each read. For an encrypted
// file, it reads the keychain once per Get.
func TestGetAsksTheKeychainOnlyForAnEncryptedFile(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name, path string
		gets       int
	}{
		{"plain", writeConfig(t, "[a]\ntype = memory\n", ""), 0},
		{"missing", filepath.Join(t.TempDir(), "rclone.conf"), 0},
		{"encrypted", writeConfig(t, "[a]\ntype = memory\n", "s3cret"), 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			secrets := &countingSecrets{memSecrets: memSecrets{}}
			s := newService(t, tc.path, secrets)
			start(t, s)
			secrets.gets = 0
			if _, err := s.Get(ctx); err != nil {
				t.Fatal(err)
			}
			if secrets.gets != tc.gets {
				t.Errorf("%d keychain reads, want %d", secrets.gets, tc.gets)
			}
		})
	}
}

// TestSaveErrorReachesGet checks that a failed save of the config is shown until a save
// succeeds.
func TestSaveErrorReachesGet(t *testing.T) {
	ctx := context.Background()
	path, readOnly := readOnlyFolder(t, "[a]\ntype = memory\n", "")
	s := newService(t, path, nil)
	start(t, s)
	readOnly(true)
	if err := store.Save(); err == nil {
		t.Fatal("a save in a read-only folder succeeded")
	}
	if got, err := s.Get(ctx); err != nil || got.SaveError == "" {
		t.Fatalf("after the failed save: %+v %v", got, err)
	}
	readOnly(false)
	if err := store.Save(); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Get(ctx); err != nil || got.SaveError != "" {
		t.Fatalf("after a good save: %+v %v", got, err)
	}
}

// TestRclonesNextSaveFollowsAPasswordChange checks that once a password change is written,
// rclone's own saves (after a token refresh) use the new key, or no key once it's removed.
func TestRclonesNextSaveFollowsAPasswordChange(t *testing.T) {
	ctx := context.Background()
	path := writeConfig(t, "", "")
	s := newService(t, path, nil)
	start(t, s)
	refresh := func(value string) {
		t.Helper()
		store.SetValue("box", "type", "memory")
		store.SetValue("box", "token", value)
		if err := store.Save(); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := s.SetPassword(ctx, "first", false); err != nil {
		t.Fatal(err)
	}
	refresh("1")
	if rclone.CheckPassword(path, "first") != nil {
		t.Fatal("a save after SetPassword isn't encrypted with it")
	}
	if _, err := s.SetPassword(ctx, "second", false); err != nil {
		t.Fatal(err)
	}
	refresh("2")
	if rclone.CheckPassword(path, "second") != nil {
		t.Fatal("a save after a password change isn't encrypted with the new one")
	}
	if pw, err := s.ChildPassword(ctx); err != nil || pw != "second" {
		t.Errorf("a child started now gets %q, %v", pw, err)
	}
	if _, err := s.RemovePassword(ctx); err != nil {
		t.Fatal(err)
	}
	refresh("3")
	if rclone.IsEncrypted(path) {
		t.Fatal("a save after RemovePassword encrypted the file")
	}
	b, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(b), "token = 3") {
		t.Errorf("the file after the saves: %q %v", b, err)
	}
	if pw, err := s.ChildPassword(ctx); err != nil || pw != "" {
		t.Errorf("a child started now gets %q, %v", pw, err)
	}
}

// keychainLog is a keychain that records the state of the config file each time its entry
// changes: which password opens the file, and whether rclone has it open.
type keychainLog struct {
	memSecrets
	path string
	log  []string
}

func (k *keychainLog) note(what string) {
	file := "plain"
	if rclone.IsEncrypted(k.path) {
		file = "locked"
		for _, pw := range []string{"old", "new"} {
			if rclone.CheckPassword(k.path, pw) == nil {
				file = "under " + pw
			}
		}
	}
	k.log = append(k.log, what+": "+file+", "+string(store.State().Status))
}

func (k *keychainLog) Set(a, s string) error {
	if a == keychain.ConfigAccount(k.path) {
		k.note("set " + s)
	}
	return k.memSecrets.Set(a, s)
}

func (k *keychainLog) Delete(a string) error {
	if a == keychain.ConfigAccount(k.path) {
		k.note("delete")
	}
	return k.memSecrets.Delete(a)
}

// TestPasswordChangeKeepsThePasswordUntilTheFileOpens covers rclone saving the config after a
// password change is written but before rclone opens the file with the new key (a token refresh
// during a transfer, for example). Usually that save reads the changed file first, so the change
// holds. When the save can't tell that the file changed (because file times are too coarse), it
// writes the file under the old key. The keychain and this run must then keep the old password
// until the file opens with the new one, or without one. Until that happens, the change is
// refused and the file stays open with the old password.
func TestPasswordChangeKeepsThePasswordUntilTheFileOpens(t *testing.T) {
	ctx := context.Background()
	path := writeConfig(t, "", "old")
	k := &keychainLog{memSecrets: memSecrets{keychain.ConfigAccount(path): "old"}, path: path}
	s := newService(t, path, k)
	start(t, s)
	// Add a remote, because a token refresh needs one. An empty file says nothing about a
	// password, and a save of it keeps rclone's key.
	rcloneconfig.FileSetValue("box", "type", "memory")
	rcloneconfig.SaveConfig()
	const (
		seen   = "a save that reads the file first"
		unseen = "a save that can't tell the file changed"
	)
	raced := func(how string) {
		rekeyWrite = func(path string, data []byte) error {
			before, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if err := writeAtomic(path, data); err != nil {
				return err
			}
			if how == unseen {
				// This writes the file as rclone had it, under the old key or without one.
				return writeAtomic(path, before)
			}
			return store.Save()
		}
	}
	kept := func(what string) {
		t.Helper()
		if len(k.log) > 0 {
			t.Errorf("%s changed the keychain: %q", what, k.log)
		}
		if k.memSecrets[keychain.ConfigAccount(path)] != "old" || s.runPassword() != "old" {
			t.Errorf("%s: the keychain has %q, the run %q", what, k.memSecrets[keychain.ConfigAccount(path)], s.runPassword())
		}
		if st := store.State(); st.Status != rclone.StatusOK || rclone.CheckPassword(path, "old") != nil {
			t.Errorf("%s left the config %v", what, st)
		}
	}

	raced(unseen)
	if _, err := s.RemovePassword(ctx); !errors.Is(err, errRekeyRaced) {
		t.Fatalf("RemovePassword, raced: %v", err)
	}
	kept("RemovePassword, raced")
	if _, err := s.SetPassword(ctx, "new", true); !errors.Is(err, errRekeyRaced) {
		t.Fatalf("SetPassword, raced: %v", err)
	}
	kept("SetPassword, raced")

	raced(seen)
	if _, err := s.SetPassword(ctx, "new", true); err != nil {
		t.Fatal(err)
	}
	if rclone.CheckPassword(path, "new") != nil {
		t.Error("SetPassword, raced by a save that read the file: not under the new password")
	}
	if _, err := s.RemovePassword(ctx); err != nil {
		t.Fatal(err)
	}
	if rclone.IsEncrypted(path) {
		t.Error("RemovePassword, raced by a save that read the file: encrypted again")
	}
	want := []string{"delete: under new, ok", "set new: under new, ok", "delete: plain, ok"}
	if !slices.Equal(k.log, want) {
		t.Errorf("the keychain changed as\n%q\nwant\n%q", k.log, want)
	}

	// When the race keeps a plain file plain, the file doesn't take the new password.
	k.log = nil
	raced(unseen)
	if _, err := s.SetPassword(ctx, "new", true); !errors.Is(err, errRekeyRaced) {
		t.Fatalf("SetPassword on a plain file, raced: %v", err)
	}
	if len(k.log) > 0 || s.runPassword() != "" || rclone.IsEncrypted(path) || store.State().Status != rclone.StatusOK {
		t.Errorf("a raced SetPassword on a plain file: keychain %q, run %q, state %v", k.log, s.runPassword(), store.State())
	}
}

// TestPasswordRemovedOutsideIsForgotten covers the file's password being removed outside the app
// (with "rclone config encryption remove" in a terminal). Once rclone has the file open in plain
// text and has dropped its key, the password is forgotten here and in the keychain. Get shows the
// file as not encrypted, and rclone's next save stays plain. An emptied file says nothing about a
// password, so the password is kept.
func TestPasswordRemovedOutsideIsForgotten(t *testing.T) {
	ctx := context.Background()
	path := writeConfig(t, "[aa]\ntype = memory\n", "old")
	account := keychain.ConfigAccount(path)
	secrets := memSecrets{account: "old"}
	s := newService(t, path, secrets)
	start(t, s)
	store.OnState(s.StateChanged) // as the core wires it
	outside := func(text string, at time.Duration) {
		t.Helper()
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		later := time.Now().Add(at)
		if err := os.Chtimes(path, later, later); err != nil {
			t.Fatal(err)
		}
		store.Poll()
		store.Poll() // the store accepts an emptied file only when a second check still sees it
	}

	outside("", time.Minute)
	if secrets[account] != "old" || s.runPassword() != "old" {
		t.Fatalf("an emptied file: the keychain has %q, the run %q", secrets[account], s.runPassword())
	}

	outside("[box]\ntype = memory\n", 2*time.Minute)
	if _, ok := secrets[account]; ok || s.runPassword() != "" {
		t.Errorf("the password removed outside: the keychain has %q, the run %q", secrets[account], s.runPassword())
	}
	got, err := s.Get(ctx)
	if err != nil || got.Status != StatusOK || got.Encrypted || got.PasswordSaved {
		t.Errorf("Get says %+v, %v", got, err)
	}
	store.SetValue("box", "token", "refreshed")
	if err := store.Save(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); rclone.IsEncrypted(path) || !strings.Contains(string(b), "token = refreshed") {
		t.Errorf("rclone's next save wrote %q", b)
	}
	if got, err := s.Get(ctx); err != nil || got.Encrypted {
		t.Errorf("after the save Get says %+v, %v", got, err)
	}
}

// TestWriteTextWaitsForAPasswordChange checks that a text write that begins during a password
// change reads the file after the change is done. It then writes it encrypted with the new
// password, instead of writing plain text over the encrypted file.
func TestWriteTextWaitsForAPasswordChange(t *testing.T) {
	ctx := context.Background()
	path := writeConfig(t, "[a]\ntype = memory\n", "")
	s := newService(t, path, nil)
	start(t, s)

	written := make(chan error, 1)
	rekeyWrite = func(p string, data []byte) error {
		go func() { written <- s.WriteText(ctx, "[bb]\ntype = memory\n") }()
		select {
		case err := <-written:
			t.Errorf("the text was written during the password change (%v)", err)
			written <- err
		case <-time.After(100 * time.Millisecond):
		}
		return writeAtomic(p, data)
	}
	if _, err := s.SetPassword(ctx, "new", false); err != nil {
		t.Fatal(err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := rclone.CheckPassword(path, "new"); err != nil {
		t.Fatalf("the text write left the file %v", err)
	}
	if text, err := s.ReadText(ctx); err != nil || !strings.Contains(text, "[bb]") {
		t.Errorf("the file reads %q %v", text, err)
	}
}

type lockedKeychain struct{ memSecrets }

func (lockedKeychain) Set(string, string) error { return errors.New("the keychain is locked") }

// TestUnlockWithAKeychainThatRefuses checks that the unlock succeeds, and that Get says the
// password wasn't saved until the password is forgotten.
func TestUnlockWithAKeychainThatRefuses(t *testing.T) {
	ctx := context.Background()
	path := writeConfig(t, "[bb]\ntype = memory\n", "pw")
	s := newService(t, path, lockedKeychain{memSecrets{}})
	start(t, s)
	const want = "Unlocked, but the password couldn't be saved to the keychain: the keychain is locked"
	got, err := s.Unlock(ctx, "pw", true)
	if err != nil || got.Status != StatusOK || got.SaveError != want {
		t.Fatalf("unlock: %+v %v", got, err)
	}
	if got, err := s.ForgetPassword(ctx); err != nil || got.SaveError != "" {
		t.Errorf("forgotten: %+v %v", got, err)
	}
	// When the password isn't meant to be kept, there is nothing to report.
	if got, err := s.Unlock(ctx, "pw", false); err != nil || got.SaveError != "" {
		t.Errorf("unlocked without keeping it: %+v %v", got, err)
	}
}

// A page gets the file's messages in the app's language, and the service keeps them in English.
func TestShownIsTranslated(t *testing.T) {
	c := &ConfigFile{}
	c.setMessage(i18n.M("Unlocked, but the password couldn't be saved to the keychain: %s", errors.New("locked")))
	c.setSaveError(i18n.M("not saved: %s", errors.New("disk full")))
	i18n.SetLanguage(i18n.Pseudo)
	defer i18n.SetLanguage(i18n.English)
	got := c.shown()
	if c.SaveError != "not saved: disk full" || got.SaveError != "[ñót sávéd: disk full]" ||
		got.Message == c.Message || !strings.HasSuffix(got.Message, ": locked]") {
		t.Errorf("shown %+v from %+v", got, c)
	}
}

// TestWriteTextAfterAnOutsidePasswordChange checks that the text editor doesn't write the file
// with a password that no longer opens it, which would undo a change made outside the app. The
// run forgets that password.
func TestWriteTextAfterAnOutsidePasswordChange(t *testing.T) {
	ctx := context.Background()
	path := writeConfig(t, "[aa]\ntype = memory\n", "old")
	s := newService(t, path, memSecrets{})
	start(t, s)
	if _, err := s.Unlock(ctx, "old", false); err != nil {
		t.Fatal(err)
	}
	data, err := rclone.EncryptConfig([]byte("[bb]\ntype = memory\n"), "new")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteText(ctx, "[cc]\ntype = memory\n"); !errors.Is(err, errPasswordChanged) {
		t.Fatalf("WriteText: %v", err)
	}
	if b, _ := os.ReadFile(path); string(b) != string(data) {
		t.Error("the file was written")
	}
	if pw := s.runPassword(); pw != "" {
		t.Errorf("the run still knows %q", pw)
	}
}
