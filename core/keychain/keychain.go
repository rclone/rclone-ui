// Package keychain stores the app's secrets (config passwords, the SMTP password) in the OS
// keychain: the macOS Keychain, the Windows Credential Manager, or the Secret Service on Linux.
// When no keychain is available (on headless Linux, or in Flatpak without the secrets portal),
// the secrets are stored in a 0600 file in the data directory instead.
package keychain

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/zalando/go-keyring"

	"github.com/rclone/rclone-ui/core/internal/atomicfile"
	"github.com/rclone/rclone-ui/core/logs"
)

// Service is the service name that the secrets are stored under.
const Service = "org.rclone.ui"

// FileName is the name of the fallback file in the data directory.
const FileName = "secrets.json"

var ErrNotFound = errors.New("no such secret")

// Keychain reads and writes secrets by account ("config:<path>", "smtp").
type Keychain struct {
	file string
	mu   sync.Mutex
}

func New(dataDir string) *Keychain {
	return &Keychain{file: filepath.Join(dataDir, FileName)}
}

// Get returns the secret of account, or ErrNotFound. It checks the file first. The file only
// holds secrets set while no keychain was available, so any copy that the keychain has from
// before is older. (Set removes the file's copy once the keychain accepts the secret.)
func (k *Keychain) Get(account string) (string, error) {
	v, ferr := k.fileGet(account)
	if ferr == nil {
		return v, nil
	}
	v, err := keyring.Get(Service, account)
	switch {
	case err == nil:
		return v, nil
	case errors.Is(ferr, ErrNotFound):
		// The secret isn't in the file, and the keychain doesn't have it or isn't available.
		return "", ErrNotFound
	default:
		return "", ferr // the file can't be read
	}
}

// Set stores the secret of account in the keychain, or in the file when no keychain is
// available. Falling back to the file is logged, so a secret kept in a file is never a surprise.
func (k *Keychain) Set(account, secret string) error {
	err := keyring.Set(Service, account, secret)
	if err == nil {
		// The file must not keep a copy that the keychain has, because Get reads the file first.
		if ferr := k.fileDelete(account); ferr != nil {
			return fmt.Errorf("the secret is in the keychain, but an older copy in %s couldn't be removed: %w", k.file, ferr)
		}
		return nil
	}
	if ferr := k.fileSet(account, secret); ferr != nil {
		return ferr
	}
	logs.Logger(logs.CompApp, "keychain").Warn("no keychain answered; the secret is kept in a file", "file", k.file, "error", err)
	return nil
}

// Delete removes the secret of account, wherever it is. A missing secret is not an error. A
// keychain that isn't available is an error, and is logged, because it may still have the secret
// from before it became unavailable.
func (k *Keychain) Delete(account string) error {
	ferr := k.fileDelete(account)
	err := keyring.Delete(Service, account)
	if err == nil || errors.Is(err, keyring.ErrNotFound) {
		return ferr
	}
	logs.Logger(logs.CompApp, "keychain").Warn("no keychain answered; a secret it has may still be there", "error", err)
	return errors.Join(ferr, fmt.Errorf("the keychain didn't answer, so it may still have the secret: %w", err))
}

func (k *Keychain) read() (map[string]string, error) {
	b, err := os.ReadFile(k.file)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	m := map[string]string{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", k.file, err)
	}
	return m, nil
}

func (k *Keychain) write(m map[string]string) error {
	if len(m) == 0 {
		err := os.Remove(k.file)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(k.file), 0o700); err != nil {
		return err
	}
	return atomicfile.WriteFile(k.file, b, 0o600)
}

func (k *Keychain) fileGet(account string) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	m, err := k.read()
	if err != nil {
		return "", err
	}
	v, ok := m[account]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}

func (k *Keychain) fileSet(account, secret string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	m, err := k.read()
	if err != nil {
		return err
	}
	m[account] = secret
	return k.write(m)
}

func (k *Keychain) fileDelete(account string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	m, err := k.read()
	if err != nil {
		return err
	}
	if _, ok := m[account]; !ok {
		return nil
	}
	delete(m, account)
	return k.write(m)
}

// ConfigAccount returns the account that an rclone config file's password is stored under.
func ConfigAccount(path string) string { return "config:" + filepath.Clean(path) }
