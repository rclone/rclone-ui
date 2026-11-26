// Adapted from rclone fs/rc/internal.go rcRunCommand (v1.75.1).

package tunnelcmd

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	rclonecmd "github.com/rclone/rclone/cmd"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/rc"
	"github.com/spf13/cobra"

	"github.com/rclone/rclone-ui/core/children/childenv"
)

// A paired phone runs rclone commands through core/command (`cat` for downloads and thumbnails),
// as subprocesses of this process. rclone's core/command starts them without --config, so they
// would read rclone's default file, and without a key, so an encrypted file wouldn't open. This
// version runs each subprocess with the tunnel's own config: its path, and for an encrypted
// file, a one-time key file for that subprocess.

var (
	keyMu  sync.Mutex
	key    []byte
	keyDir string
)

// When the app runs this command as a child, the key is in a one-time file, which is read and
// kept before rclone reads and deletes it. In a terminal, rclone asks for the password (or reads
// RCLONE_CONFIG_PASS, or runs --password-command). It then hands the key over the way it does
// for its own daemon mode, and this function takes it from there.
func loadConfig() error {
	childenv.GuardConfig()
	if path := os.Getenv(childenv.KeyFileEnv); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("the config's key: %w", err)
		}
		keyMu.Lock()
		key, keyDir = b, filepath.Dir(path)
		keyMu.Unlock()
		_ = config.LoadedData() // reads and deletes the key file
		// While this is set, rclone would try to read the deleted file again at every reload,
		// fail, and later save its startup copy over the app's edits. Unsetting it makes reloads
		// use the key in memory.
		_ = os.Unsetenv(childenv.KeyFileEnv)
		return nil
	}
	config.PassConfigKeyForDaemonization = true
	_ = config.LoadedData()
	config.PassConfigKeyForDaemonization = false
	path := os.Getenv(childenv.KeyFileEnv)
	if path == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	_ = os.Remove(path)
	_ = os.Unsetenv(childenv.KeyFileEnv)
	if err != nil {
		return fmt.Errorf("the config's key: %w", err)
	}
	keyMu.Lock()
	key, keyDir = b, os.TempDir()
	keyMu.Unlock()
	return nil
}

func installCommand() {
	orig := rc.Calls.Get("core/command")
	if orig == nil {
		return
	}
	c := *orig
	c.Fn = runCommand
	rc.Add(c)
}

func runCommand(ctx context.Context, in rc.Params) (rc.Params, error) {
	command, err := in.GetString("command")
	if err != nil {
		command = ""
	}
	opt := map[string]string{}
	if err := in.GetStructMissingOK("opt", &opt); err != nil {
		return nil, err
	}
	arg := []string{}
	if err := in.GetStructMissingOK("arg", &arg); err != nil {
		return nil, err
	}
	returnType, err := in.GetString("returnType")
	if err != nil {
		returnType = "COMBINED_OUTPUT"
	}

	var allArgs []string
	if command != "" {
		allArgs = append(allArgs, command)
	}
	allArgs = append(allArgs, arg...)
	for k, v := range opt {
		if len(k) == 1 {
			allArgs = append(allArgs, "-"+k)
		} else {
			allArgs = append(allArgs, "--"+k)
		}
		allArgs = append(allArgs, v)
	}
	if name := refusedCommand(rclonecmd.Root, allArgs); name != "" {
		return nil, refusal(name)
	}
	httpResponse, err := in.GetHTTPResponseWriter()
	if err != nil {
		return nil, fmt.Errorf("response object is required\n%w", err)
	}
	if _, ok := opt["config"]; !ok {
		allArgs = append(allArgs, "--config", config.GetConfigPath())
	}

	ex, err := os.Executable()
	if err != nil {
		return nil, err
	}
	env, cleanup, err := commandEnv()
	if err != nil {
		return nil, err
	}
	defer cleanup()
	cmd := exec.CommandContext(ctx, ex, allArgs...)
	cmd.Env = env

	switch returnType {
	case "COMBINED_OUTPUT":
		out, err := cmd.CombinedOutput()
		return rc.Params{"result": string(out), "error": err != nil}, nil
	case "STREAM_ONLY_STDOUT":
		cmd.Stdout = httpResponse
	case "STREAM_ONLY_STDERR":
		cmd.Stderr = httpResponse
	case "STREAM":
		cmd.Stdout, cmd.Stderr = httpResponse, httpResponse
	default:
		return nil, fmt.Errorf("unknown returnType %q", returnType)
	}
	return nil, cmd.Run()
}

var refused = []string{"update", "selfupdate", "self-update"}

var roles = []string{"ui", "metadata-map", "mcp"}

func appRole(word string) string {
	switch {
	case slices.Contains(roles, word):
		return word
	case strings.HasPrefix(word, "rclone:"):
		return "an rclone: link"
	case strings.HasPrefix(word, "-psn_"):
		return word
	}
	return ""
}

// findMu serializes calls to cobra's Find, which writes to the commands it walks, while the rc
// serves calls concurrently.
var findMu sync.Mutex

// cobra looks for the command twice: in the words as sent, which is how the subprocess reads them,
// and in the words lowercased and trimmed. Both are needed. A flag's case changes how cobra
// skips it: -P is rclone's --progress, which takes no value, while -p is no flag of rclone's, so
// cobra reads the next word as its value. Lowercased, `-P update` would hide update.
func refusedCommand(root *cobra.Command, args []string) string {
	words := make([]string, len(args))
	for i, a := range args {
		words[i] = strings.ToLower(strings.TrimSpace(a))
	}
	if len(words) > 0 && slices.Contains(refused, words[0]) {
		return words[0]
	}
	if len(words) > 0 {
		if role := appRole(words[0]); role != "" {
			return role
		}
	}
	for _, in := range [][]string{args, words} {
		if name := refusedIn(root, in); name != "" {
			return name
		}
	}
	return ""
}

func refusedIn(root *cobra.Command, args []string) string {
	findMu.Lock()
	found, _, _ := root.Find(args)
	findMu.Unlock()
	for c := found; c != nil && c != root; c = c.Parent() {
		if slices.Contains(refused, c.Name()) {
			return c.Name()
		}
	}
	return ""
}

func commandEnv() (env []string, cleanup func(), err error) {
	env, cleanup = os.Environ(), func() {}
	keyMu.Lock()
	k, dir := key, keyDir
	keyMu.Unlock()
	if k == nil {
		return env, cleanup, nil
	}
	name, err := childenv.WriteKeyFile(dir, k)
	if err != nil {
		return nil, nil, err
	}
	cleanup = func() { _ = os.Remove(name) }
	return append(env, childenv.KeyFileEnv+"="+name), cleanup, nil
}

func refusal(name string) error {
	if slices.Contains(refused, name) {
		return fmt.Errorf("the tunnel does not run %s: update Rclone UI on the computer it runs on", name)
	}
	return fmt.Errorf("the tunnel does not run %s: it starts Rclone UI itself, not an rclone command", name)
}
