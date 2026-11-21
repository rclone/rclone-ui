// Command rcui is Rclone UI and rclone in one executable. The arguments choose the role before
// anything else runs, so a mount child or a CLI call never touches the UI's single-instance lock,
// its windows or its data.
package main

import (
	"os"
	"path/filepath"
	"strings"

	_ "github.com/rclone/rclone/backend/all" // every backend, as rclone ships
	rclonecmd "github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/all" // every command; -tags noselfupdate leaves out rclone's selfupdate
	_ "github.com/rclone/rclone/lib/plugin"
	"github.com/spf13/cobra"

	"github.com/rclone/rclone-ui/app"
	"github.com/rclone/rclone-ui/app/deeplink"
	"github.com/rclone/rclone-ui/app/update"
	"github.com/rclone/rclone-ui/core/agents"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/children/childenv"
	"github.com/rclone/rclone-ui/core/metadatamap"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/tunnel/cloudflared"
	"github.com/rclone/rclone-ui/core/tunnel/tunnelcmd"
)

type role int

const (
	roleUI role = iota
	roleMapper
	roleAgents
	roleRclone
)

// dispatch reads the role from the executable's name and its arguments. Only the words below
// belong to rcui. Everything else is passed to rclone's command line, so `rcui rcd` runs
// `rclone rcd`. A test fails if rclone ever registers a command with one of these names.
func dispatch(argv0 string, args []string) (role, []string) {
	// Split on both separators so that a Windows argv[0] is recognised on any OS the tests run on.
	base := argv0[strings.LastIndexAny(argv0, `/\`)+1:]
	name := strings.ToLower(strings.TrimSuffix(base, filepath.Ext(base)))
	if name == "rclone" {
		return roleRclone, args
	}
	if len(args) == 0 {
		return roleUI, nil
	}
	switch first := args[0]; {
	case first == "ui":
		return roleUI, args[1:]
	case first == "metadata-map":
		return roleMapper, args[1:]
	case first == "mcp":
		return roleAgents, args[1:]
	case deeplink.IsLink(first),
		// macOS adds a process serial number to apps started from old Finder paths.
		strings.HasPrefix(first, "-psn_"):
		return roleUI, args
	}
	return roleRclone, args
}

// calledAs returns the name this process was run as. An AppImage's runtime always starts its Exec
// (rcui), whatever name the image was run as, including the rclone link on PATH (see
// app/pathlink). The runtime passes the original name in $ARGV0.
func calledAs(argv0 string, getenv func(string) string) string {
	if getenv("APPIMAGE") != "" {
		if name := getenv("ARGV0"); name != "" {
			return name
		}
	}
	return argv0
}

func main() {
	r, args := dispatch(calledAs(os.Args[0], os.Getenv), os.Args[1:])
	switch r {
	case roleUI:
		os.Exit(app.Run(args))
	case roleMapper:
		// rclone runs this once per file while the app is running, so it takes no lock, opens no
		// data and writes no log.
		os.Exit(metadatamap.Main(args, os.Stdin, os.Stdout, os.Stderr))
	case roleAgents:
		// `rcui mcp` connects an agent that an MCP client started to the running app's server
		// (core/agents). Like the mapper, it takes no lock and opens no data.
		os.Exit(agents.Bridge(args, os.Stdin, os.Stdout, os.Stderr))
	default:
		consoleForCLI()
		if conf, ok := rclone.PortableConfig(); ok {
			// Created now, so that the next rclone command finds it at init (EnsurePortableConfig).
			// A command that can't create it still runs, with the file named by --config.
			_ = rclone.EnsurePortableConfig()
			args = withConfig(args, conf, os.LookupEnv)
		}
		runRclone(args)
	}
}

// withConfig puts --config=conf in front of args, unless args name a config file of their own or
// RCLONE_CONFIG is set. A portable copy's rclone uses it for the rclone.conf in the copy's folder
// (rclone.PortableConfig). Setting the path in code isn't enough, because rclone takes the
// default of --config from its config path at init, before main runs. A "--" ends the flags, so a
// --config after it is an argument and not a flag.
func withConfig(args []string, conf string, lookupEnv func(string) (string, bool)) []string {
	if _, set := lookupEnv("RCLONE_CONFIG"); set {
		return args
	}
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if arg == "--config" || strings.HasPrefix(arg, "--config=") {
			return args
		}
	}
	return append([]string{"--config=" + conf}, args...)
}

// runRclone runs rclone's own main with a few changes. The update command updates Rclone UI, which
// includes its rclone, and rclone's selfupdate is replaced by a note. The tunnel command runs the
// remote tunnel, with cloudflared built in. A child that the core started (a mount, a serve or the
// tunnel) also exits when the app closes its end of the child's stdin, so an app that died never
// leaves a mount behind.
func runRclone(args []string) {
	if childenv.Adopt(children.OwnMount) {
		// No rclone command sets PersistentPreRun. It runs after rclone's init has started the rc.
		rclonecmd.Root.PersistentPreRun = func(*cobra.Command, []string) { childenv.Ready() }
	}
	update.Install(rclonecmd.Root)
	tunnelcmd.Install(rclonecmd.Root, cloudflared.Start)
	rclonecmd.Root.SetArgs(args)
	rclonecmd.Main()
}
