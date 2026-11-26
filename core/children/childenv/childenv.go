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

const Env = "RCUI_CHILD"

// KeyFileEnv is how rclone hands a config key to a process it starts (its mount --daemon, see
// fs/config/crypt.go:133-148). The variable holds the path of a file with the obscured key, and
// the process reads the file and deletes it. The core passes an encrypted config's key to its
// children the same way, so the password never appears in their arguments or environment.
const KeyFileEnv = "_RCLONE_CONFIG_KEY_FILE"

const MountEnv = "RCUI_CHILD_MOUNT"

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

func Mark(cmd *exec.Cmd) (io.WriteCloser, error) {
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	cmd.Env = append(cmd.Env, Env+"="+strconv.Itoa(os.Getpid()))
	return cmd.StdinPipe()
}

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
	if null, err := os.Open(os.DevNull); err == nil {
		os.Stdin = null
	}
	return true
}

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
