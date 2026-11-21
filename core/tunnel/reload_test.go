package tunnel

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/rclone"
)

// TestTunnelReloadsEncryptedConfig checks that with an encrypted config, the tunnel reads the
// file again after the app added a remote, and that a phone's config/create keeps that remote.
// The tunnel reads its key file itself (loadConfig), so it must unset rclone's variable there,
// as Ready does for the other children.
func TestTunnelReloadsEncryptedConfig(t *testing.T) {
	f := newFixture(t)
	const password = "s3cret"
	photos := t.TempDir()
	base := "[photos]\ntype = alias\nremote = " + filepath.ToSlash(photos) + "\n"
	encrypt := func(text string) {
		t.Helper()
		enc, err := rclone.EncryptConfig([]byte(text), password)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f.configs.path, enc, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	encrypt(base)
	f.configs.password = password
	originFile := filepath.Join(t.TempDir(), "origin")
	t.Setenv(originFileEnv, originFile)

	st, err := f.s.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.s.Stop(context.Background()) }()
	origin, err := os.ReadFile(originFile)
	if err != nil {
		t.Fatal(err)
	}
	post := func(path, body string) string {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, string(origin)+"/"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.SetBasicAuth(st.User, st.Pass)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = res.Body.Close() }()
		b, _ := io.ReadAll(res.Body)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d %s", path, res.StatusCode, b)
		}
		return string(b)
	}
	if body := post("config/listremotes", "{}"); !strings.Contains(body, `"photos"`) {
		t.Fatalf("config/listremotes at the start: %s", body)
	}

	encrypt(base + "\n[added_by_core]\ntype = alias\nremote = " + filepath.ToSlash(t.TempDir()) + "\n")
	if body := post("config/listremotes", "{}"); !strings.Contains(body, `"added_by_core"`) {
		t.Fatalf("config/listremotes after the core's edit: %s", body)
	}

	post("config/create", `{"name":"phone","type":"alias","parameters":{"remote":"`+filepath.ToSlash(t.TempDir())+`"}}`)
	data, err := os.ReadFile(f.configs.path)
	if err != nil {
		t.Fatal(err)
	}
	text, err := rclone.DecryptConfig(data, password)
	if err != nil || !rclone.IsEncrypted(f.configs.path) {
		t.Fatalf("the phone's save isn't encrypted with the password: %v", err)
	}
	for _, name := range []string{"[photos]", "[added_by_core]", "[phone]"} {
		if !strings.Contains(string(text), name) {
			t.Errorf("%s is missing after the phone's save:\n%s", name, text)
		}
	}
}
