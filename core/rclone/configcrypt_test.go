package rclone

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/obscure"

	"github.com/rclone/rclone-ui/core/children/childenv"
)

func TestEncryptDecryptConfig(t *testing.T) {
	plain := []byte("[mem]\ntype = memory\n")
	enc, err := EncryptConfig(plain, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "rclone.conf")
	if err := os.WriteFile(path, enc, 0o600); err != nil {
		t.Fatal(err)
	}
	// Check what rclone's own reader checks: the header and the password.
	if !IsEncrypted(path) || CheckPassword(path, "s3cret") != nil {
		t.Fatal("not an rclone encrypted config")
	}
	if !errors.Is(CheckPassword(path, "nope"), ErrWrongPassword) {
		t.Error("a wrong password opened it")
	}
	got, err := DecryptConfig(enc, "s3cret")
	if err != nil || string(got) != string(plain) {
		t.Errorf("DecryptConfig = %q, %v", got, err)
	}
	if _, err := DecryptConfig(enc, "nope"); !errors.Is(err, ErrWrongPassword) {
		t.Errorf("wrong password: %v", err)
	}
	if got, err := DecryptConfig(plain, "any"); err != nil || string(got) != string(plain) {
		t.Errorf("a plain file: %q %v", got, err)
	}
}

func TestChildKeyFile(t *testing.T) {
	dir := t.TempDir()
	path, err := ChildKeyFile(dir, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// Windows has no file modes. There the file gets the access rules of its folder.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", info.Mode().Perm())
	}
	if filepath.Dir(path) != dir {
		t.Errorf("written to %s, not in %s", path, dir)
	}
	b, _ := os.ReadFile(path)
	key, _ := configKey("s3cret")
	if obscure.MustReveal(string(b)) != string(key[:]) {
		t.Error("the file isn't the obscured key rclone expects")
	}
}

// rclone's own reader (config.Decrypt) opens what EncryptConfig writes with the same password,
// and DecryptConfig opens what rclone writes (config.Encrypt). rclone's key is left unset, as
// the tests' plain config needs.
func TestConfigCryptIsRclones(t *testing.T) {
	if config.IsEncrypted() {
		t.Fatal("rclone has a key before the test, which it could not restore")
	}
	t.Cleanup(config.ClearConfigPassword)
	t.Setenv(childenv.KeyFileEnv, "") // otherwise rclone's Decrypt would read the key from it
	plain := "[a]\ntype = memory\npass = x\n"
	for _, password := range []string{"s3cret", "pässwörd ﬁle"} {
		enc, err := EncryptConfig([]byte(plain), password)
		if err != nil {
			t.Fatal(err)
		}
		if err := config.SetConfigPassword(password); err != nil {
			t.Fatal(err)
		}
		r, err := config.Decrypt(bytes.NewReader(enc))
		if err != nil {
			t.Fatalf("rclone can't open ours: %v", err)
		}
		if got, _ := io.ReadAll(r); string(got) != plain {
			t.Errorf("rclone reads ours as %q", got)
		}

		var theirs bytes.Buffer
		err = config.Encrypt(strings.NewReader(plain), &theirs)
		config.ClearConfigPassword()
		if err != nil {
			t.Fatal(err)
		}
		if got, err := DecryptConfig(theirs.Bytes(), password); err != nil || string(got) != plain {
			t.Errorf("rclone's opened as %q, %v", got, err)
		}
	}
}
