package keychain

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestTheOSKeychain(t *testing.T) {
	keyring.MockInit()
	k := New(t.TempDir())
	if _, err := k.Get("smtp"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unset secret: %v", err)
	}
	if err := k.Set("smtp", "pw"); err != nil {
		t.Fatal(err)
	}
	if v, err := k.Get("smtp"); err != nil || v != "pw" {
		t.Fatalf("Get = %q, %v", v, err)
	}
	if _, err := os.Stat(k.file); !errors.Is(err, os.ErrNotExist) {
		t.Error("the file was written while the keychain answered")
	}
	if err := k.Delete("smtp"); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("smtp"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after Delete: %v", err)
	}
	if err := k.Delete("smtp"); err != nil {
		t.Errorf("deleting twice: %v", err)
	}
}

func TestTheFileWhenNoKeychainAnswers(t *testing.T) {
	keyring.MockInitWithError(errors.New("no secret service"))
	dir := t.TempDir()
	k := New(dir)
	if err := k.Set("host:a", "token"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	// Windows has no file modes. There the file gets the access rules of its folder.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", info.Mode().Perm())
	}
	if v, err := k.Get("host:a"); err != nil || v != "token" {
		t.Fatalf("Get = %q, %v", v, err)
	}
	// The file's copy is removed, but Delete reports an error, because the keychain wasn't
	// available and may still have a copy from before.
	if err := k.Delete("host:a"); err == nil {
		t.Error("a delete no keychain answered said nothing")
	}
	if _, err := os.Stat(filepath.Join(dir, FileName)); !errors.Is(err, os.ErrNotExist) {
		t.Error("an empty file was left behind")
	}

	// A secret is stored in the file, and then the keychain comes back. The secret is still found,
	// and a new Set moves it to the keychain.
	if err := k.Set("smtp", "old"); err != nil {
		t.Fatal(err)
	}
	keyring.MockInit()
	if v, err := k.Get("smtp"); err != nil || v != "old" {
		t.Fatalf("a file secret with the keychain back: %q, %v", v, err)
	}
	if err := k.Set("smtp", "new"); err != nil {
		t.Fatal(err)
	}
	if v, _ := k.fileGet("smtp"); v != "" {
		t.Error("the file kept a copy the keychain has")
	}
}

// TestAnOutageLeavesNoStaleSecret checks that a secret changed while the keychain was unavailable
// is read from the file once the keychain is back, not from the keychain's older copy.
func TestAnOutageLeavesNoStaleSecret(t *testing.T) {
	keyring.MockInitWithError(errors.New("no secret service"))
	k := New(t.TempDir())
	if err := k.Set("smtp", "new"); err != nil {
		t.Fatal(err)
	}
	// The keychain is back, with the copy it had before it became unavailable.
	keyring.MockInit()
	if err := keyring.Set(Service, "smtp", "old"); err != nil {
		t.Fatal(err)
	}
	if v, err := k.Get("smtp"); err != nil || v != "new" {
		t.Fatalf("Get = %q, %v: want the file's newer copy", v, err)
	}
	if err := k.Delete("smtp"); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("smtp"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after Delete: %v", err)
	}
}
