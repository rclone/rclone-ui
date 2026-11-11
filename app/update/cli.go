package update

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/rclone/rclone-ui/core/version"
)

//go:embed update.md
var updateHelp string

// Exit codes, the same as rclone's: 1 for a failure and 2 for a usage error.
const (
	exitError = 1
	exitUsage = 2
)

// Install adds `update` to rclone's root command. It updates Rclone UI, which includes its rclone.
// If the build includes rclone's own `selfupdate` (a build without -tags noselfupdate), it is
// replaced by a note that points to `update`, because it would put official rclone in place of
// rcui. `version --check` reads Rclone UI's feed.
func Install(root *cobra.Command) {
	c := &cli{
		out:        os.Stdout,
		errOut:     os.Stderr,
		appRunning: appRunning,
		handOff:    handOff,
		name:       invokedAs(os.Args[0]),
		terminal:   term.IsTerminal(int(os.Stdout.Fd())),
	}
	c.install(root)
}

type cli struct {
	out, errOut io.Writer
	// engine holds the base options for every Engine the commands create. Tests use it to set
	// the feeds and keys.
	engine Options
	// appRunning reports whether the app is running, and handOff passes the update to it.
	appRunning func() bool
	handOff    func(ctx context.Context, version string, ch Channel) error
	// name is the command the user typed ("rcui" or "rclone"), used in the hints.
	name string
	// terminal means stdout is a terminal, so progress redraws a single line.
	terminal bool
}

// install replaces any selfupdate command, and any update command that an earlier install added.
// (rclone has no update command of its own, which main_test.go checks.)
func (c *cli) install(root *cobra.Command) {
	for _, cmd := range root.Commands() {
		if cmd.Name() == "selfupdate" || cmd.Name() == "update" {
			root.RemoveCommand(cmd)
		}
	}
	root.AddCommand(c.updateCommand(), c.selfUpdateCommand())
	c.wrapVersionCheck(root)
}

func invokedAs(argv0 string) string {
	name := filepath.Base(argv0)
	if n, ok := strings.CutSuffix(strings.ToLower(name), ".exe"); ok {
		name = name[:len(n)]
	}
	if name == "" || name == "." {
		return "rcui"
	}
	return name
}

// updateFlags are the same flags as rclone's selfupdate, with the same names and meanings.
type updateFlags struct {
	check   bool
	output  string
	stable  bool
	beta    bool
	version string
	pkg     string
}

func (c *cli) updateCommand() *cobra.Command {
	var f updateFlags
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update Rclone UI, and the rclone it brings.",
		Long:  strings.TrimSpace(updateHelp),
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, _ []string) {
			if code := c.update(commandContext(cmd), f); code != 0 {
				os.Exit(code)
			}
		},
	}
	fl := cmd.Flags()
	fl.BoolVar(&f.check, "check", false, "Check for the latest release, do not download")
	fl.StringVar(&f.output, "output", "", "Save the downloaded release at a given path (default: install it)")
	fl.BoolVar(&f.stable, "stable", false, "Install the stable release (this is the default)")
	fl.BoolVar(&f.beta, "beta", false, "Install the beta release")
	fl.StringVar(&f.version, "version", "", "Install the given Rclone UI version (default: latest)")
	fl.StringVar(&f.pkg, "package", "", "Package format: zip|deb|rpm (default: zip, this install's own)")
	return cmd
}

const selfUpdateNote = "rclone is part of Rclone UI here, so it is updated with the whole app: run `rcui update`, or `rclone update` through the rclone link on your PATH."

// selfUpdateCommand replaces rclone's `selfupdate` for users who type it. It explains how to
// update and does nothing else, whatever flags it is given.
func (c *cli) selfUpdateCommand() *cobra.Command {
	return &cobra.Command{
		Use:                "selfupdate",
		Aliases:            []string{"self-update"},
		Short:              "rclone comes with Rclone UI: see update.",
		Long:               selfUpdateNote,
		DisableFlagParsing: true,
		Run: func(*cobra.Command, []string) {
			fmt.Fprintln(c.out, selfUpdateNote)
		},
	}
}

func commandContext(cmd *cobra.Command) context.Context {
	if ctx := cmd.Context(); ctx != nil {
		return ctx
	}
	return context.Background()
}

func (c *cli) update(ctx context.Context, f updateFlags) int {
	if f.stable && f.beta {
		return c.usage("--stable and --beta are mutually exclusive")
	}
	if err := CheckVersion(f.version); errors.Is(err, ErrBadVersion) {
		return c.usage("--version: " + err.Error())
	} else if err != nil {
		return c.fail(err)
	}
	switch f.pkg {
	case "", "zip":
		f.pkg = ""
	case "deb", "rpm":
		if runtime.GOOS != "linux" {
			return c.usage(errPackageNotLinux.Error())
		}
	default:
		return c.usage(errPackageValue.Error())
	}
	if f.check && !(f.stable || f.beta || f.output != "" || f.version != "" || f.pkg != "") {
		c.printVersions(ctx)
		return 0
	}

	ch := Stable
	if f.beta {
		ch = Beta
	}
	opts := c.engine
	opts.Channel, opts.Version, opts.Package = ch, f.version, f.pkg
	opts.Terminal, opts.NoRelaunch = true, true
	e := New(opts)

	rel, err := e.Check(ctx)
	if err != nil {
		return c.fail(err)
	}
	// A portable copy doesn't update itself, and neither does the app that runs from it, so the
	// command shows where to download the release instead. --output still downloads.
	portable := e.InstallType() == TypePortable && f.output == ""
	if f.check && portable {
		c.downloadPage(c.out, rel)
		return 0
	}
	if f.check {
		where := f.output
		if where == "" {
			where = e.InstallLocation()
		}
		fmt.Fprintf(c.out, "Without --check this would install Rclone UI %s at %s\n", rel.Describe(), where)
		return 0
	}
	if f.output != "" {
		art, err := c.download(ctx, e, rel)
		if err != nil {
			return c.fail(err)
		}
		dst, err := art.SaveAs(f.output)
		if err != nil {
			art.Remove()
			return c.fail(err)
		}
		fmt.Fprintf(c.out, "Downloaded Rclone UI %s at %s\n", rel.Describe(), dst)
		return 0
	}
	if rel.Same() {
		fmt.Fprintf(c.out, "Rclone UI %s is up to date.\n", Describe(e.CurrentVersion(), version.Rclone()))
		return 0
	}
	if portable {
		c.downloadPage(c.errOut, rel)
		return exitError
	}

	// A running app updates itself, because it stops its transfers, mounts and serves first, and
	// on Windows nothing may keep rcui.exe open. It is passed the release announced here, rather
	// than its own channel's latest, which may be a different one.
	if c.appRunning() {
		if err := c.handOff(ctx, rel.Version, ch); err == nil {
			fmt.Fprintf(c.out, "Rclone UI is running; it will ask you to confirm the update to %s, then restart.\n", rel.Describe())
			return 0
		}
	}

	if err := e.installable(rel.Kind); err != nil {
		if errors.Is(err, ErrCantSelfUpdate) {
			_, why := e.CanSelfUpdate()
			fmt.Fprintln(c.errOut, why)
			if e.InstallType() == TypeUnmanaged {
				fmt.Fprintf(c.errOut, "`%s update --output PATH` downloads it.\n", c.name)
			}
			return exitError
		}
		return c.fail(err)
	}

	note := ""
	if !rel.Newer() {
		note = " (an older release)"
	}
	fmt.Fprintf(c.out, "Updating Rclone UI %s → %s%s\n", e.CurrentVersion(), rel.Describe(), note)
	art, err := c.download(ctx, e, rel)
	if err != nil {
		return c.fail(err)
	}
	if _, err := e.Install(ctx, art); err != nil {
		art.Remove()
		return c.fail(err)
	}
	if art.Kind == KindNSIS {
		// Keep the file, because the installer reads it after this process exits.
		fmt.Fprintf(c.out, "The Rclone UI %s installer is running; it finishes once this command exits.\n", rel.Version)
		return 0
	}
	art.Remove()
	fmt.Fprintf(c.out, "Updated Rclone UI from %s to %s.\n", e.CurrentVersion(), rel.Describe())
	return 0
}

// download fetches the artifact and shows progress on stdout: one redrawn line on a terminal, or
// a summary otherwise. The engine throttles the progress calls.
func (c *cli) download(ctx context.Context, e *Engine, rel *Release) (*Artifact, error) {
	var size int64
	progress := func(done, total int64) {
		size = done
		if !c.terminal {
			return
		}
		if total > 0 {
			fmt.Fprintf(c.out, "\rDownloading %3d%% (%s of %s)", done*100/total, megabytes(done), megabytes(total))
		} else {
			fmt.Fprintf(c.out, "\rDownloading %s", megabytes(done))
		}
	}
	art, err := e.Download(ctx, rel, progress)
	if c.terminal {
		fmt.Fprintln(c.out)
	}
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(c.out, "Downloaded %s.\n", megabytes(size))
	return art, nil
}

func megabytes(n int64) string { return fmt.Sprintf("%.1f MB", float64(n)/1e6) }

func (c *cli) downloadPage(w io.Writer, rel *Release) {
	fmt.Fprintln(w, PortableNote)
	fmt.Fprintf(w, "Rclone UI %s is on its release page: %s\n", rel.Describe(), ReleasePage(rel.Version))
}

// printVersions runs `update --check` and `version --check`. It prints this version and the
// latest on each channel, in the layout of rclone's `version --check`. A portable copy is marked
// on the first line.
func (c *cli) printVersions(ctx context.Context) {
	e := New(c.engine)
	current := e.CurrentVersion()
	mark := ""
	if e.InstallType() == TypePortable {
		mark = " (portable)"
	}
	fmt.Fprintf(c.out, "%-8sRclone UI %s%s\n", "yours:", Describe(current, version.Rclone()), mark)
	for _, ch := range []Channel{Stable, Beta} {
		c.printLatest(ctx, e, ch, current)
	}
	if compareVersions(current, "0.0.0") < 0 {
		fmt.Fprintln(c.out, "Your version is a development build, so comparisons may be wrong.")
	}
}

// printLatest prints printVersions' line for one channel. Each channel gets its own checkTimeout.
// A newer release gets a line on how to upgrade: the command, or the release's page for a portable
// copy, as rclone's own `version --check` gives a URL.
func (c *cli) printLatest(ctx context.Context, e *Engine, ch Channel, current string) {
	label, flag := "latest", ""
	if ch == Beta {
		label, flag = "beta", " --beta"
	}
	ctx, cancel := withCheckTimeout(ctx)
	defer cancel()
	f, err := e.latest(ctx, ch)
	if errors.Is(err, ErrNoRelease) {
		fmt.Fprintf(c.out, "%-8s%v\n", label+":", err)
		return
	}
	if err != nil {
		fmt.Fprintf(c.errOut, "Failed to get the Rclone UI %s version: %v\n", label, feedTimedOut(ctx, err))
		return
	}
	released := ""
	if t, err := time.Parse(time.RFC3339, f.Release.Date); err == nil {
		released = "(released " + t.Format("2006-01-02") + ")"
	}
	fmt.Fprintf(c.out, "%-8s%-40s %20s\n", label+":", "Rclone UI "+Describe(f.Release.Version, f.Rclone), released)
	switch {
	case compareVersions(f.Release.Version, current) <= 0:
	case e.InstallType() == TypePortable:
		fmt.Fprintf(c.out, "  upgrade: %s\n", ReleasePage(f.Release.Version))
	default:
		fmt.Fprintf(c.out, "  upgrade: %s update%s\n", c.name, flag)
	}
}

// wrapVersionCheck makes `version --check` print Rclone UI's versions. `version` alone and
// `version --deps` still run rclone's code.
func (c *cli) wrapVersionCheck(root *cobra.Command) {
	for _, cmd := range root.Commands() {
		if cmd.Name() != "version" || cmd.Annotations["rcui-check"] != "" {
			continue
		}
		run, runE := cmd.Run, cmd.RunE
		cmd.Run = nil
		cmd.RunE = func(cmd *cobra.Command, args []string) error {
			check, _ := cmd.Flags().GetBool("check")
			deps, _ := cmd.Flags().GetBool("deps")
			if check && !deps && len(args) == 0 {
				c.printVersions(commandContext(cmd))
				return nil
			}
			if runE != nil {
				return runE(cmd, args)
			}
			if run != nil {
				run(cmd, args)
			}
			return nil
		}
		if f := cmd.Flags().Lookup("check"); f != nil {
			f.Usage = "Check for a newer Rclone UI (it brings its rclone)"
		}
		if cmd.Annotations == nil {
			cmd.Annotations = map[string]string{}
		}
		cmd.Annotations["rcui-check"] = "wrapped"
	}
}

func (c *cli) usage(msg string) int {
	fmt.Fprintln(c.errOut, "Error:", msg)
	return exitUsage
}

func (c *cli) fail(err error) int {
	fmt.Fprintln(c.errOut, "Error:", err)
	return exitError
}
