package children

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/rc"

	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// TestEncryptedChildKeepsOutsideEdits checks that a child on an encrypted config reads the file
// again after the core changes it, and that the child's own save keeps that change. While the
// key file variable is set, rclone reads the key file at every decrypt. A child that kept the
// variable could never reload, and would save its startup copy over the core's remote.
func TestEncryptedChildKeepsOutsideEdits(t *testing.T) {
	a := newApp(t, Limits{LogLevel: "INFO"})
	const password = "s3cret"
	encrypt := func(text string) {
		t.Helper()
		enc, err := rclone.EncryptConfig([]byte(text), password)
		if err != nil {
			t.Fatal(err)
		}
		writeFile(t, a.config, string(enc))
	}
	plain, err := os.ReadFile(a.config)
	if err != nil {
		t.Fatal(err)
	}
	encrypt(string(plain))

	addr := freeAddr(t)
	up := make(chan struct{}, 1)
	u, err := a.s.Start(Spec{
		Name: "serve", Kind: KindServe, Addr: addr, ConfigPath: a.config, ConfigPassword: password,
		Rclone:    []string{"serve", "http", "photos:", "--addr=" + addr},
		Component: logs.CompServes, Subcomponent: "http:" + addr,
		Ready:  func(ctx context.Context, _ *Process) error { return tcpReady(ctx, addr) },
		OnUp:   func(*Unit) { up <- struct{}{} },
		OnDown: func(*Unit, Down) bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-up:
	case <-u.Done():
		t.Fatal("the encrypted serve ended before it was up")
	case <-time.After(60 * time.Second):
		t.Fatal("the encrypted serve was not up in time")
	}

	// The core adds a remote, and the child sees it.
	encrypt(string(plain) + "\n[added_by_core]\ntype = alias\nremote = " + filepath.ToSlash(t.TempDir()) + "\n")
	dump := rcCall(t, u.RC(), "config/dump", nil)
	if _, ok := dump["added_by_core"]; !ok {
		t.Fatalf("the child's config/dump after the core's edit: %v", dump)
	}

	// The child saves (as a token refresh would). The core's remote stays, under the same key.
	rcCall(t, u.RC(), "config/create", rc.Params{
		"name": "child_saved", "type": "alias",
		"parameters": rc.Params{"remote": filepath.ToSlash(t.TempDir())},
	})
	data, err := os.ReadFile(a.config)
	if err != nil {
		t.Fatal(err)
	}
	text, err := rclone.DecryptConfig(data, password)
	if err != nil {
		t.Fatalf("the child's save doesn't open with the password: %v", err)
	}
	if !rclone.IsEncrypted(a.config) {
		t.Fatal("the child saved the config in plain text")
	}
	for _, name := range []string{"[photos]", "[added_by_core]", "[child_saved]"} {
		if !strings.Contains(string(text), name) {
			t.Errorf("%s is missing after the child's save:\n%s", name, text)
		}
	}
}
