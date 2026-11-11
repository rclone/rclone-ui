// Package datadir manages the data directory. It knows the default location, which a portable
// copy keeps next to its executable (Portable), the lock that allows only one core to use it, the
// run directory and the folder for the sockets.
package datadir

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Identifier is the name of the app's folder inside the OS data directory.
const Identifier = "org.rclone.ui"

// The names of the app's files and folders inside the data directory.
const (
	AppDB      = "app.db"
	AgentsFile = "agents.json" // where the agents' server listens, and its token (core/agents)
	LockFile   = "core.lock"
	LogsDir    = "logs" // rcui.log and rcui.log.1 (core/logs), and crash.log (app/crashlog.go)
	RunDirName = "run"
	CacheDir   = "cache" // rclone's cache dir (config.SetCacheDir)
)

var ErrLocked = errors.New("the data directory is in use by another copy of Rclone UI")

// Default returns the OS local data directory joined with Identifier. That is
// ~/Library/Application Support on macOS, $XDG_DATA_HOME (or ~/.local/share) on Linux, and
// %LOCALAPPDATA% on Windows. The data here is tied to this machine (mount points, the run
// directory), so it is never a roaming folder. A portable copy (see Portable) uses the data
// folder next to its executable instead.
func Default() (string, error) {
	if root, ok := Portable(); ok {
		return filepath.Join(root, PortableDir), nil
	}
	local, err := localDataDir()
	if err != nil {
		return "", fmt.Errorf("could not resolve the local data directory: %w", err)
	}
	return filepath.Join(local, Identifier), nil
}

// Lock creates dir (0700) if needed and takes an OS lock on <dir>/core.lock. It keeps trying until
// wait has passed, because a restarted app can start while the previous one is still shutting
// down. The lock is released when the process ends (or execs), so a crash never leaves it held.
func Lock(ctx context.Context, dir string, wait time.Duration) (release func(), err error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, LockFile)
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for {
		ok, err := tryLock(f)
		if err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if ok {
			return func() {
				unlock(f)
				_ = f.Close()
			}, nil
		}
		left := time.Until(deadline)
		if left <= 0 {
			_ = f.Close()
			return nil, fmt.Errorf("%w (%s is held); stop it first", ErrLocked, path)
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, ctx.Err()
		case <-time.After(min(left, 250*time.Millisecond)):
		}
	}
}

// A Unix socket's path has a length limit (sun_path is 104 bytes on macOS, including the NUL, and
// 108 on Linux and Windows). So the children's sockets are kept in a short folder of their own
// (SocketDir). MaxSocketName is the longest socket name that the folder leaves room for.
const (
	maxSocketPath = 103
	MaxSocketName = 24
)

// RunDir returns the folder for children.json and the children's one-time key files. It is
// override when given, or else <data>/run, however long that path is. It stays in the data dir
// because the list in children.json of what to start again must survive a reboot. The folder is
// created with mode 0700 and must belong to this user.
func RunDir(dataDir, override string) (string, error) {
	dir := override
	if dir == "" {
		abs, err := filepath.Abs(dataDir)
		if err != nil {
			return "", err
		}
		dir = filepath.Join(abs, RunDirName)
	}
	return privateDir(dir)
}

// SocketDir returns the folder for the children's sockets. It is override when given
// ($APP_RUN_DIR), or else $XDG_RUNTIME_DIR/rcui-<8 hex>, or else <temp>/rcui-<uid>-<8 hex>. The
// hex comes from a hash of the data dir's absolute path, so two data dirs never share a folder. A
// socket's path there stays short however long the data dir's path is, and no socket outlives its
// child. The folder is created with mode 0700 and must belong to this user, because anyone can
// create the name first in a shared temp folder.
func SocketDir(dataDir, override string) (string, error) {
	dir := override
	if dir == "" {
		abs, err := filepath.Abs(dataDir)
		if err != nil {
			return "", err
		}
		sum := sha256.Sum256([]byte(abs))
		tag := hex.EncodeToString(sum[:4])
		if xdg := os.Getenv("XDG_RUNTIME_DIR"); xdg != "" && filepath.IsAbs(xdg) {
			dir = filepath.Join(xdg, "rcui-"+tag)
		} else {
			dir = filepath.Join(os.TempDir(), "rcui-"+uidPrefix()+tag)
		}
	}
	return privateDir(dir)
}

// privateDir creates dir with mode 0700 and checks that it belongs to this user.
func privateDir(dir string) (string, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := ownPrivateDir(dir); err != nil {
		return "", fmt.Errorf("%s: %w", dir, err)
	}
	return dir, nil
}
