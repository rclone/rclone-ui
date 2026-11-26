package childenv

import (
	"bytes"
	"context"
	"crypto/sha256"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configfile"
	"github.com/rclone/rclone/fs/config/obscure"
)

func encryptedConfig(t *testing.T, plain, password string) []byte {
	t.Helper()
	if err := config.SetConfigPassword(password); err != nil {
		t.Fatal(err)
	}
	defer config.ClearConfigPassword()
	var out bytes.Buffer
	if err := config.Encrypt(strings.NewReader(plain), &out); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// writeOutside replaces the config as another process would. It dates the file a minute later,
// so the change is detected whatever the file system's clock resolution.
func writeOutside(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
}

func startChild(t *testing.T, plain, password string) string {
	t.Helper()
	ci := fs.GetConfig(context.Background())
	ask := ci.AskPassword
	ci.AskPassword = false
	orig := config.GetConfigPath()
	t.Cleanup(func() {
		ci.AskPassword = ask
		config.ClearConfigPassword()
		_ = config.SetConfigPath(orig)
	})
	dir := t.TempDir()
	path := filepath.Join(dir, "rclone.conf")
	data := []byte(plain)
	if password != "" {
		data = encryptedConfig(t, plain, password)
		key := sha256.Sum256([]byte("[" + password + "][rclone-config]"))
		keyFile, err := WriteKeyFile(dir, []byte(obscure.MustObscure(string(key[:]))))
		if err != nil {
			t.Fatal(err)
		}
		t.Setenv(KeyFileEnv, keyFile)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := config.SetConfigPath(path); err != nil {
		t.Fatal(err)
	}
	configfile.Install()
	Ready()
	if v, _ := config.FileGetValue("box", "token"); v != "1" {
		t.Fatalf("the child read token %q", v)
	}
	return path
}

const (
	before  = "[box]\ntype = memory\ntoken = 1\n"
	outside = "[box]\ntype = memory\ntoken = 2\n\n[other]\ntype = memory\n"
)

func TestChildRefusesToSaveAfterAFailedReload(t *testing.T) {
	for _, c := range []struct {
		name, password string
	}{
		{"password changed", "old"},
		{"password set", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			path := startChild(t, before, c.password)
			newer := encryptedConfig(t, outside, "new")

			writeOutside(t, path, newer)
			_ = config.SetValueAndSave("box", "token", "refreshed")
			if got, _ := os.ReadFile(path); !bytes.Equal(got, newer) {
				t.Fatalf("the child saved over the file:\n%s", got)
			}

			writeOutside(t, path, []byte(outside))
			_ = config.SetValueAndSave("box", "token", "3")
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if s := string(got); !strings.Contains(s, "token = 3") || !strings.Contains(s, "[other]") {
				t.Errorf("after the file read again, the child saved:\n%s", s)
			}
		})
	}
}

func TestChildSavesPlainAfterThePasswordIsRemoved(t *testing.T) {
	path := startChild(t, before, "old")

	writeOutside(t, path, []byte(outside))
	_ = config.SetValueAndSave("box", "token", "refreshed")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if s := string(got); strings.Contains(s, "RCLONE_ENCRYPT") || !strings.Contains(s, "token = refreshed") || !strings.Contains(s, "[other]") {
		t.Errorf("the child saved:\n%s", s)
	}
}
