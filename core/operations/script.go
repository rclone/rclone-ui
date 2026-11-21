package operations

import (
	"fmt"
	"maps"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// This file writes an operation as rclone commands, which "Copy command" on the operation pages
// gives the user for a terminal or a script. The commands run what the app runs: the steps of
// the transfer's plan, or the command of a mount's or a serve's child. They leave out what only
// the app needs: the flags that every child gets, and a mount's NFS port and cache folder.

// Script is an operation as rclone commands for this computer's shell, and as a TypeScript
// program that runs it through rclone's API with rclone-sdk (sdk.go).
type Script struct {
	Lines []string `json:"lines"`
	SDK   string   `json:"sdk"`
}

// Script returns the plan for a script. config is the config file that the commands must name,
// or "" for rclone's default one (rclone.ScriptConfig). goos decides the shell.
func (p Plan) Script(exe, goos, config string) (Script, error) {
	commands, err := p.Commands(exe)
	if err != nil {
		return Script{}, err
	}
	calls, err := p.sdkCalls(exe)
	if err != nil {
		return Script{}, err
	}
	return Script{Lines: ScriptLines(commands, goos, config), SDK: sdkProgram(calls, goos, config)}, nil
}

// MountScript returns a mount for a script, as Plan.Script does for a transfer. env.OS decides
// the mount command and the shell.
func MountScript(a MountArgs, env MountEnv, config string) (Script, error) {
	command, err := mountCommand(a, env)
	if err != nil {
		return Script{}, err
	}
	call, err := sdkMount(a, env)
	if err != nil {
		return Script{}, err
	}
	return Script{
		Lines: ScriptLines([]ScriptCommand{command}, env.OS, config),
		SDK:   sdkProgram([]sdkCall{call}, env.OS, config),
	}, nil
}

// ServeScript returns a serve for a script, as Plan.Script does for a transfer.
func ServeScript(a ServeArgs, env ServeEnv, goos, config string) (Script, error) {
	command, err := serveCommand(a, env)
	if err != nil {
		return Script{}, err
	}
	call, err := sdkServe(a, env)
	if err != nil {
		return Script{}, err
	}
	return Script{
		Lines: ScriptLines([]ScriptCommand{command}, goos, config),
		SDK:   sdkProgram([]sdkCall{call}, goos, config),
	}, nil
}

type ScriptCommand struct {
	// Args come after `rclone`.
	Args []string
	// Env holds the variables that the command needs, as NAME=value: a serve's credentials,
	// which the app never puts on a command line either.
	Env []string
}

// Commands returns the plan's steps as rclone commands, one for each step, in order. Each one
// has the plan's options as flags, and a step that reads a folder has the filters too, as Run
// gives them. exe is put in front of the app's own metadata mapper.
func (p Plan) Commands(exe string) ([]ScriptCommand, error) {
	config, err := flagsOf(GroupConfig, options(p.Config), []string{blockMain}, exe)
	if err != nil {
		return nil, err
	}
	filter, err := flagsOf(GroupFilter, options(p.Filter), []string{blockFilter}, exe)
	if err != nil {
		return nil, err
	}
	out := make([]ScriptCommand, 0, len(p.Steps))
	for _, s := range p.Steps {
		args, err := s.commandArgs()
		if err != nil {
			return nil, err
		}
		if s.CreateEmptySrcDirs {
			args = append(args, "--create-empty-src-dirs")
		}
		if s.DeleteEmptySrcDirs {
			args = append(args, "--delete-empty-src-dirs")
		}
		if s.Op == OpBisync {
			args = append(args, bisyncFlags(p.Bisync)...)
		}
		args = append(args, config...)
		if s.Folder() {
			args = append(args, filter...)
		}
		out = append(out, ScriptCommand{Args: args})
	}
	return out, nil
}

// commandArgs returns the rclone command that does what the step does, with its paths. A file
// step names its file in its folder, with copyto or moveto, which take the file's new name.
func (s Step) commandArgs() ([]string, error) {
	from, to := scriptPath(s.Src), scriptPath(s.Dst)
	src := scriptPath(joinFs(s.Src, s.SrcRemote))
	dst := scriptPath(joinFs(s.Dst, s.DstRemote))
	switch s.Op {
	case OpCopy, OpMove, OpSync, OpBisync:
		return []string{s.Op, from, to}, nil
	case OpCopyFile:
		return []string{"copyto", src, dst}, nil
	case OpMoveFile:
		return []string{"moveto", src, dst}, nil
	case OpDelete, OpCleanup:
		return []string{s.Op, from}, nil
	case OpDeleteFile, OpPurge:
		return []string{s.Op, src}, nil
	case OpCopyURL:
		return []string{s.Op, s.URL, dst}, nil
	}
	return nil, fmt.Errorf("a %q step has no command", s.Op)
}

// scriptPath returns a path on this computer as a user would type it. The app writes a local
// path as a remote of the local backend (`:local:/tmp/x/`), and rclone reads the absolute path
// that follows as the same folder. Any other Fs string is returned as it is.
func scriptPath(fsString string) string {
	rest, ok := strings.CutPrefix(fsString, ":local:")
	if !ok || !filepath.IsAbs(rest) {
		return fsString
	}
	return filepath.FromSlash(rest)
}

// bisyncFlags writes a bisync's parameters (bisyncParams) as the flags of `rclone bisync`, sorted
// by name. A switch that is off is left out, because every switch is off by default. maxDelete is
// left out when it has the command line's own default (defaultMaxDelete).
func bisyncFlags(params map[string]any) []string {
	var flags []string
	for _, name := range slices.Sorted(maps.Keys(params)) {
		v := params[name]
		if v == false || isBlank(v) || name == "maxDelete" && fmt.Sprint(v) == fmt.Sprint(defaultMaxDelete) {
			continue
		}
		flag := "--" + bisyncFlag(name)
		if v == true {
			flags = append(flags, flag)
			continue
		}
		text, err := elementText(v)
		if err != nil {
			text = fmt.Sprint(v)
		}
		flags = append(flags, flag+"="+text)
	}
	return flags
}

// bisyncFlag returns the flag of a sync/bisync parameter: its words in lower case, joined with
// hyphens (maxDelete is --max-delete).
func bisyncFlag(name string) string {
	var b strings.Builder
	for _, r := range name {
		if unicode.IsUpper(r) {
			b.WriteByte('-')
			r = unicode.ToLower(r)
		}
		b.WriteRune(r)
	}
	return b.String()
}

// mountCommand returns a mount as a command for a script: the mount command, the Fs and the mount
// point, then the flags from the page's groups. On macOS, rclone picks the NFS port itself.
func mountCommand(a MountArgs, env MountEnv) (ScriptCommand, error) {
	if env.NFSPort <= 0 {
		env.NFSPort = 1 // required by MountCommand, and not part of the script
	}
	m, err := MountCommand(a, env)
	if err != nil {
		return ScriptCommand{}, err
	}
	return ScriptCommand{Args: append([]string{m.Args[0], scriptPath(m.Source), m.MountPoint}, m.Flags...)}, nil
}

// serveCommand returns a serve as a command for a script, with its credentials as variables.
func serveCommand(a ServeArgs, env ServeEnv) (ScriptCommand, error) {
	s, err := ServeCommand(a, env)
	if err != nil {
		return ScriptCommand{}, err
	}
	args := slices.Clone(s.Args) // serve, the type, then the Fs
	args[2] = scriptPath(args[2])
	return ScriptCommand{Args: args, Env: s.Env}, nil
}

// The words that each shell reads as they are. Anything else is quoted. PowerShell also treats a
// comma as a list and an @ as a splat, so neither is plain there.
var (
	plainPOSIX      = regexp.MustCompile(`^[\w@%+=:,./-]+$`)
	plainPowerShell = regexp.MustCompile(`^[\w%+=:./\\-]+$`)
)

// ScriptLines writes commands as lines for the shell of goos: PowerShell on Windows, and a POSIX
// shell anywhere else. Each command starts with rclone. config, when it isn't "", is the config
// file that the app uses instead of rclone's default, and is added as each command's --config.
// A command's variables come first: in front of the command in a POSIX shell, and on lines of
// their own in PowerShell.
func ScriptLines(commands []ScriptCommand, goos, config string) []string {
	powerShell := goos == "windows"
	var lines []string
	for _, c := range commands {
		args := c.Args
		if config != "" {
			args = append(slices.Clone(args), "--config="+config)
		}
		words := make([]string, 0, len(c.Env)+len(args)+1)
		for _, v := range c.Env {
			name, value, _ := strings.Cut(v, "=")
			if powerShell {
				lines = append(lines, "$env:"+name+" = "+shellWord(value, true))
			} else {
				words = append(words, name+"="+shellWord(value, false))
			}
		}
		words = append(words, "rclone")
		for _, arg := range args {
			words = append(words, shellArg(arg, powerShell))
		}
		lines = append(lines, strings.Join(words, " "))
	}
	return lines
}

// shellArg quotes one argument. A flag keeps its name plain and has only its value quoted, as
// in --exclude='*.tmp'. Both shells pass that on as --exclude=*.tmp.
func shellArg(arg string, powerShell bool) string {
	if name, value, ok := strings.Cut(arg, "="); ok && strings.HasPrefix(name, "--") {
		return name + "=" + shellWord(value, powerShell)
	}
	return shellWord(arg, powerShell)
}

// shellWord quotes a word so that the shell reads it back unchanged. A plain word is left as it
// is. Anything else goes in single quotes. A single quote inside them is closed, escaped and
// opened again in a POSIX shell, and doubled in PowerShell.
func shellWord(word string, powerShell bool) string {
	if powerShell {
		if plainPowerShell.MatchString(word) {
			return word
		}
		return "'" + strings.ReplaceAll(word, "'", "''") + "'"
	}
	if plainPOSIX.MatchString(word) {
		return word
	}
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}
