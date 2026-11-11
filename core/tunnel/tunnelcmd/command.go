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
// file, a one-time key file for that subprocess. It refuses the updater, and the words that
// start the app itself rather than rclone.

// key is the config's obscured key, used to write the subprocesses' key files in keyDir. It is
// nil for a plain config.
var (
	keyMu  sync.Mutex
	key    []byte
	keyDir string
)

// loadConfig reads the config and keeps its key. When the app runs this command as a child, the
// key is in a one-time file, which is read and kept before rclone reads and deletes it. In a
// terminal, rclone asks for the password (or reads RCLONE_CONFIG_PASS, or runs
// --password-command). It then hands the key over the way it does for its own daemon mode, and
// this function takes it from there. In both cases, the config refuses to save after a failed
// reload (childenv.GuardConfig). Otherwise a password changed in the meantime would end up as a
// plain file.
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
		return nil // a plain config
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

// installCommand replaces rclone's core/command with this one.
func installCommand() {
	orig := rc.Calls.Get("core/command")
	if orig == nil {
		return
	}
	c := *orig
	c.Fn = runCommand
	rc.Add(c)
}

// runCommand is rclone's rcRunCommand, but it gives the subprocess the tunnel's config, and
// refuses the commands that a phone may not run (refusedCommand).
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
	// Use the tunnel's own config file, unless the command names one.
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

// refused are the commands that a phone may not run through core/command. The updater replaces
// this executable and restarts the app, which nothing reached over a public address should be
// able to do. self-update is an alias of selfupdate.
var refused = []string{"update", "selfupdate", "self-update"}

// roles are the first words that main sends to the app rather than to rclone (dispatch in
// main.go). With them, a phone could start a window, the metadata mapper or the agents' server
// on the computer. rclone: links and macOS's -psn_ argument also start the window.
var roles = []string{"ui", "metadata-map", "mcp"}

// appRole returns the role word or link that would make the subprocess run as the app rather
// than rclone, or "". main compares the first word exactly. This check is stricter, because the
// caller has already lowercased the word and trimmed its spaces.
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

// refusedCommand returns the command of a core/command call that the tunnel refuses, or "". That
// is either the command the subprocess would run, found in args the way cobra finds it below root
// (skipping flags before it, and resolving an alias to its command's name), or an app role in
// the first word, which main checks before rclone's commands. Each word is compared regardless of
// case or surrounding spaces.
//
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

// refusedIn returns the refused command that cobra finds in args below root, or "".
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

// commandEnv returns this process's environment for a subprocess. When the config is encrypted,
// it adds a one-time key file for that subprocess. cleanup removes the file if the subprocess
// never read it.
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

// refusal returns the error for a refused command. The updater must be run on the computer
// itself.
func refusal(name string) error {
	if slices.Contains(refused, name) {
		return fmt.Errorf("the tunnel does not run %s: update Rclone UI on the computer it runs on", name)
	}
	return fmt.Errorf("the tunnel does not run %s: it starts Rclone UI itself, not an rclone command", name)
}
