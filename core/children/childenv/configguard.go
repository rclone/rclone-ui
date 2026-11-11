package childenv

import (
	"bufio"
	"errors"
	"os"
	"strings"
	"sync"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
)

// GuardConfig makes this process's rclone config refuse to save after a failed reload. rclone
// reads its config file again when the file changes on disk. If that read fails, rclone keeps the
// copy it had (configfile.go:34-49), and its next save (such as a token refresh) writes that copy
// over the file. If the file failed to decrypt, rclone has also dropped its key
// (crypt.go:175-177), so the save writes the config in plain text, tokens included
// (crypt.go:217-221). This happens to a child when its config's password is changed or set by
// another process: `rclone config encryption set` in a terminal, the app, or another instance of
// the app. With the guard, the config is saved again only once the file can be read. And when a
// reload finds that the password was removed by another process, later saves are plain text
// rather than encrypted with the old key (see load).
func GuardConfig() {
	if config.GetConfigPath() == "" {
		return // rclone's in-memory config has no file to overwrite
	}
	if _, ok := config.Data().(*guardedConfig); ok {
		return
	}
	config.SetData(&guardedConfig{Storage: config.Data()})
}

// guardedConfig wraps rclone's config storage. It reloads the file here when it changes, rather
// than letting rclone's storage do it, because rclone's storage logs a failure and carries on.
// Every access checks the file first, so rclone's own check in the same access finds nothing
// new. A file written in the few microseconds between the two checks is read only by rclone's
// storage, which can lose an outside edit on its own anyway.
type guardedConfig struct {
	config.Storage // rclone's storage, which reads and writes the file

	mu     sync.Mutex
	read   os.FileInfo // the file as it was when last read or written
	failed error       // why the last read of the file failed; nil once a read succeeds
}

// fresh reads the file again if it changed since it was last read or written, using the same
// test as rclone (configfile.go:34-49). The caller holds g.mu.
func (g *guardedConfig) fresh() {
	path := config.GetConfigPath()
	if path == "" {
		return
	}
	fi, err := os.Stat(path)
	if err != nil {
		return // rclone doesn't read a file it can't stat either
	}
	if g.read != nil && fi.ModTime().Equal(g.read.ModTime()) && fi.Size() == g.read.Size() {
		return
	}
	_ = g.load(fi) // the error is kept in g.failed
	if g.failed != nil {
		fs.Errorf(nil, "The config file changed and couldn't be read again: keeping the previous config, which won't be saved until the file reads: %v", g.failed)
	}
}

// load reads the file into rclone's storage and records whether the read failed. A missing file
// is not a failure, because rclone keeps its config and creates the file. fi is the file as it
// was before the read, so a change made during the read is picked up next time. The caller holds
// g.mu.
//
// If the file is plain while a key is held, another process removed its password. rclone reads a
// plain file without using the key (crypt.go:57-86), but would encrypt its next save with that
// key again. So load drops the key, and saves stay plain.
func (g *guardedConfig) load(fi os.FileInfo) error {
	err := g.Storage.Load()
	g.read = fi
	if err != nil && !errors.Is(err, config.ErrorConfigFileNotFound) {
		g.failed = err
		return err
	}
	g.failed = nil
	if err == nil && config.IsEncrypted() && PlainConfig(config.GetConfigPath()) {
		fs.Infof(nil, "The config file's password was removed: saving it unencrypted")
		config.ClearConfigPassword()
	}
	return err
}

// PlainConfig reports whether the config file at path has content and is not encrypted. That is,
// its first line that isn't blank or a comment is not rclone's encryption header, checked the
// way rclone's Decrypt does it (crypt.go:57-86). A reload uses this rule to decide whether to drop
// rclone's key, both here and in the core's config store (core/rclone). An empty file proves
// nothing, because an editor may empty a file before it writes it again, so the key is kept.
func PlainConfig(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadString('\n')
		if l := strings.TrimSpace(line); l != "" && !strings.HasPrefix(l, ";") && !strings.HasPrefix(l, "#") {
			return !strings.HasPrefix(l, "RCLONE_ENCRYPT_V")
		}
		if err != nil {
			return false
		}
	}
}

func (g *guardedConfig) Load() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	fi, _ := os.Stat(config.GetConfigPath()) // nil when the file is missing; the next check reads it
	return g.load(fi)
}

// Save implements config.Storage. It refuses to save while the file can't be read, because the
// save would write the copy that rclone had before the file changed, in plain text if rclone lost
// its key. A refusal is logged and returns nil, because rclone's SaveConfig would only retry it.
func (g *guardedConfig) Save() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fresh()
	if g.failed != nil {
		fs.Errorf(nil, "Not saving the config file: it changed and couldn't be read again (%v), and saving would overwrite it with an older copy, unencrypted if its password changed", g.failed)
		return nil
	}
	if err := g.Storage.Save(); err != nil {
		return err
	}
	if fi, err := os.Stat(config.GetConfigPath()); err == nil {
		g.read = fi
	}
	return nil
}

func (g *guardedConfig) GetSectionList() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fresh()
	return g.Storage.GetSectionList()
}

func (g *guardedConfig) HasSection(section string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fresh()
	return g.Storage.HasSection(section)
}

func (g *guardedConfig) DeleteSection(section string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fresh()
	g.Storage.DeleteSection(section)
}

func (g *guardedConfig) GetKeyList(section string) []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fresh()
	return g.Storage.GetKeyList(section)
}

func (g *guardedConfig) GetValue(section, key string) (string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fresh()
	return g.Storage.GetValue(section, key)
}

func (g *guardedConfig) SetValue(section, key, value string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fresh()
	g.Storage.SetValue(section, key, value)
}

func (g *guardedConfig) DeleteKey(section, key string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fresh()
	return g.Storage.DeleteKey(section, key)
}

func (g *guardedConfig) Serialize() (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fresh()
	return g.Storage.Serialize()
}

var _ config.Storage = (*guardedConfig)(nil)
