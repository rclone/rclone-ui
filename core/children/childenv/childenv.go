// Package childenv is the contract between the core and the rcui processes it starts (a mount,
// a serve, the tunnel). The core marks the child in its environment. When the child sees the
// mark, it ends as soon as the core's end of its stdin closes. So if the app dies, however it
// dies, it never leaves a mount or an open rc port behind.
package childenv

import (
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"

	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/rc"
	"github.com/rclone/rclone/lib/atexit"
	"github.com/rclone/rclone/lib/exitcode"
)

// Env is the variable that marks a child of the core. Its value is the app's pid, for the logs.
const Env = "RCUI_CHILD"

// KeyFileEnv is how rclone hands a config key to a process it starts (its mount --daemon, see
// fs/config/crypt.go:133-148). The variable holds the path of a file with the obscured key, and
// the process reads the file and deletes it. The core passes an encrypted config's key to its
// children the same way, so the password never appears in their arguments or environment.
const KeyFileEnv = "_RCLONE_CONFIG_KEY_FILE"

// MountEnv gives a mount child its mount point, so it can unmount it as it ends (Adopt).
const MountEnv = "RCUI_CHILD_MOUNT"

// WriteKeyFile writes contents (a key, obscured as rclone does it) to a new 0600 file in dir, for
// a child's KeyFileEnv, and returns the file's path. If the write fails, the file is removed.
func WriteKeyFile(dir string, contents []byte) (string, error) {
	f, err := os.CreateTemp(dir, "key-*")
	if err != nil {
		return "", err
	}
	if _, err := f.Write(contents); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return "", err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// Mark sets up cmd as a child. It adds the mark to its environment and creates a pipe for its
// stdin, which the core holds open for as long as the child runs. The returned writer is the
// core's end of the pipe. Closing it, or the app exiting, ends the child.
func Mark(cmd *exec.Cmd) (io.WriteCloser, error) {
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	cmd.Env = append(cmd.Env, Env+"="+strconv.Itoa(os.Getpid()))
	return cmd.StdinPipe()
}

// Adopt runs in every rclone CLI process before rclone's main. In a child of the core, it does
// three things. It clears the mark, because a command that the child runs itself (like
// core/command's `rcui cat`) is not the core's child. It ignores SIGPIPE, so a log line written
// after the app died can't kill the child before it has unmounted. And it ends the child when its
// stdin closes. In any other process it does nothing and returns false.
//
// ownMount is called in a mount child with its mount point (MountEnv). The function it returns
// runs as the child ends, after rclone's own exit handlers, and unmounts what they left mounted.
func Adopt(ownMount func(mountPoint string) func()) bool {
	if _, ok := os.LookupEnv(Env); !ok {
		return false
	}
	_ = os.Unsetenv(Env)
	var unmount func()
	if mountPoint := os.Getenv(MountEnv); mountPoint != "" && ownMount != nil {
		unmount = ownMount(mountPoint)
	}
	_ = os.Unsetenv(MountEnv)
	IgnoreSIGPIPE()
	stdin := os.Stdin
	go func() {
		_, _ = io.Copy(io.Discard, stdin)
		// atexit.Run unmounts a mount (mountlib registers the unmount) and stops a serve.
		atexit.Run()
		if unmount != nil {
			unmount()
		}
		os.Exit(exitcode.UncategorizedError)
	}()
	// Only the goroutine above reads the pipe. Anything rclone reads from stdin gets nothing.
	if null, err := os.Open(os.DevNull); err == nil {
		os.Stdin = null
	}
	return true
}

// Ready runs in an adopted child once rclone's init has started the rc server (as a
// PersistentPreRun of rclone's root command). It makes the config refuse to save after a failed
// reload (GuardConfig), loads an encrypted config with its key file, and makes the rc socket
// private. The tunnel loads its config and starts its rc server itself, later, and calls
// GuardConfig and PrivateRC at that point.
func Ready() {
	GuardConfig()
	if os.Getenv(KeyFileEnv) != "" {
		// While this is set, rclone reads the key file at every decrypt, but deletes it after the
		// first one. Every later reload would fail, and the child would then save its startup copy
		// of the config over the file.
		_ = config.LoadedData()     // reads and deletes the key file
		_ = os.Unsetenv(KeyFileEnv) // later reloads use the key held in memory
	}
	PrivateRC()
}

// PrivateRC makes a child's rc socket readable and writable only by its owner, whatever umask it
// inherited. On Windows the socket keeps its own ACLs.
func PrivateRC() {
	if !rc.Opt.Enabled || runtime.GOOS == "windows" {
		return
	}
	for _, addr := range rc.Opt.HTTP.ListenAddr {
		if path, ok := strings.CutPrefix(addr, "unix://"); ok {
			_ = os.Chmod(path, 0o600)
		}
	}
}
