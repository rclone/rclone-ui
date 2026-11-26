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

// Script is an operation as rclone commands for this computer's shell, and as a TypeScript
// program that runs it through rclone's API with rclone-sdk.
type Script struct {
	Lines []string `json:"lines"`
	SDK   string   `json:"sdk"`
}

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
	Args []string
	Env  []string
}

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

func scriptPath(fsString string) string {
	rest, ok := strings.CutPrefix(fsString, ":local:")
	if !ok || !filepath.IsAbs(rest) {
		return fsString
	}
	return filepath.FromSlash(rest)
}

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

func mountCommand(a MountArgs, env MountEnv) (ScriptCommand, error) {
	if env.NFSPort <= 0 {
		env.NFSPort = 1
	}
	m, err := MountCommand(a, env)
	if err != nil {
		return ScriptCommand{}, err
	}
	return ScriptCommand{Args: append([]string{m.Args[0], scriptPath(m.Source), m.MountPoint}, m.Flags...)}, nil
}

func serveCommand(a ServeArgs, env ServeEnv) (ScriptCommand, error) {
	s, err := ServeCommand(a, env)
	if err != nil {
		return ScriptCommand{}, err
	}
	args := slices.Clone(s.Args)
	args[2] = scriptPath(args[2])
	return ScriptCommand{Args: args, Env: s.Env}, nil
}

// PowerShell treats a comma as a list and an @ as a splat.
var (
	plainPOSIX      = regexp.MustCompile(`^[\w@%+=:,./-]+$`)
	plainPowerShell = regexp.MustCompile(`^[\w%+=:./\\-]+$`)
)

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

func shellArg(arg string, powerShell bool) string {
	if name, value, ok := strings.Cut(arg, "="); ok && strings.HasPrefix(name, "--") {
		return name + "=" + shellWord(value, powerShell)
	}
	return shellWord(arg, powerShell)
}

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
