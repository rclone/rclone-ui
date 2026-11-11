package update

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// testCLI returns the command set up against a fake feed, with no app running unless appRunning
// says so.
func testCLI(t *testing.T, f *feed, current string) (*cli, *bytes.Buffer, *bytes.Buffer) {
	var out, errOut bytes.Buffer
	return &cli{
		out:        &out,
		errOut:     &errOut,
		engine:     f.options(t, current),
		appRunning: func() bool { return false },
		handOff:    func(context.Context, string, Channel) error { return errors.New("no app runs") },
		name:       "rclone",
	}, &out, &errOut
}

// run parses args the way the update command would, and runs it.
func (c *cli) run(t *testing.T, args ...string) int {
	t.Helper()
	cmd := c.updateCommand()
	var code int
	cmd.Run = nil
	cmd.RunE = func(*cobra.Command, []string) error { return nil }
	if err := cmd.ParseFlags(args); err != nil {
		t.Fatal(err)
	}
	fl := cmd.Flags()
	var f updateFlags
	f.check, _ = fl.GetBool("check")
	f.output, _ = fl.GetString("output")
	f.stable, _ = fl.GetBool("stable")
	f.beta, _ = fl.GetBool("beta")
	f.version, _ = fl.GetString("version")
	f.pkg, _ = fl.GetString("package")
	code = c.update(context.Background(), f)
	return code
}

func TestUpdateFlags(t *testing.T) {
	f := newFeed(t)
	c, _, errOut := testCLI(t, f, "4.0.1")
	if code := c.run(t, "--stable", "--beta"); code != exitUsage || !strings.Contains(errOut.String(), "mutually exclusive") {
		t.Errorf("--stable --beta: %d %q", code, errOut)
	}
	errOut.Reset()
	if code := c.run(t, "--package", "msi"); code != exitUsage || !strings.Contains(errOut.String(), "zip|deb|rpm") {
		t.Errorf("--package msi: %d %q", code, errOut)
	}
	if runtime.GOOS != "linux" {
		errOut.Reset()
		if code := c.run(t, "--package", "deb"); code != exitUsage || !strings.Contains(errOut.String(), "only on Linux") {
			t.Errorf("--package deb: %d %q", code, errOut)
		}
	}
	// The flags have the same names as rclone's selfupdate flags.
	cmd := c.updateCommand()
	for _, name := range []string{"check", "output", "stable", "beta", "version", "package"} {
		if cmd.Flags().Lookup(name) == nil {
			t.Errorf("no --%s", name)
		}
	}
	if cmd.Name() != "update" || len(cmd.Aliases) != 0 {
		t.Errorf("the command is %q, aliases %v", cmd.Name(), cmd.Aliases)
	}
	if !strings.Contains(cmd.Long, "Rclone UI") {
		t.Error("the help isn't Rclone UI's")
	}
}

func TestUpdateVersionRefused(t *testing.T) {
	f := newFeed(t)
	c, out, errOut := testCLI(t, f, "4.0.1")
	for _, tc := range []struct {
		version string
		code    int
		said    string
	}{
		{"3.7.5", exitError, "Rclone UI 3.7.5: no such release"},
		{"4.0", exitUsage, `"4.0" is not an Rclone UI version`},
		{"../../latest/download/x", exitUsage, "is not an Rclone UI version"},
		{"4.0.0/../../3.7.5", exitUsage, "is not an Rclone UI version"},
	} {
		out.Reset()
		errOut.Reset()
		if code := c.run(t, "--version", tc.version, "--output", t.TempDir()); code != tc.code || !strings.Contains(errOut.String(), tc.said) {
			t.Errorf("--version %s: %d %q, want %d %q", tc.version, code, errOut, tc.code, tc.said)
		}
		if out.Len() != 0 {
			t.Errorf("--version %s said %q", tc.version, out)
		}
	}
	if f.downloads.Load() != 0 {
		t.Error("a refused version was downloaded")
	}
}

func TestUpdateBeforeTheFirstStableRelease(t *testing.T) {
	_, kind := nativeType()
	f := newFeed(t)
	f.beta = f.release("4.0.0-beta.2", "v1.76.2", kind, artifactBytes(kind))
	c, out, errOut := testCLI(t, f, "4.0.0-beta.1")
	if code := c.run(t, "--check"); code != 0 {
		t.Fatalf("--check: %d %q", code, errOut)
	}
	for _, want := range []string{"yours:  Rclone UI 4.0.0-beta.1", "latest: no stable release of Rclone UI yet", "beta:   Rclone UI 4.0.0-beta.2"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("--check lacks %q:\n%s", want, out)
		}
	}
	if errOut.Len() != 0 {
		t.Errorf("--check failed: %q", errOut)
	}
	errOut.Reset()
	if code := c.run(t, "--check", "--stable"); code != exitError || !strings.Contains(errOut.String(), "Error: no stable release of Rclone UI yet") {
		t.Errorf("--check --stable: %d %q", code, errOut)
	}
}

func TestSelfUpdateOnlySays(t *testing.T) {
	f := newFeed(t)
	_, kind := nativeType()
	f.stable = f.release("4.0.2", "", kind, artifactBytes(kind))
	c, out, errOut := testCLI(t, f, "4.0.1")
	root := &cobra.Command{Use: "rclone"}
	c.install(root)
	for _, args := range [][]string{{"selfupdate"}, {"self-update", "--beta", "--version", "4.0.2"}, {"selfupdate", "--check"}} {
		out.Reset()
		root.SetArgs(args)
		if err := root.Execute(); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if got := out.String(); got != selfUpdateNote+"\n" {
			t.Errorf("%v said %q", args, got)
		}
	}
	if errOut.Len() != 0 || f.downloads.Load() != 0 {
		t.Errorf("selfupdate did more: %q, %d downloads", errOut, f.downloads.Load())
	}
	for _, want := range []string{"rcui update", "rclone update"} {
		if !strings.Contains(selfUpdateNote, want) {
			t.Errorf("the note doesn't name %s", want)
		}
	}
}

func TestUpdateCheck(t *testing.T) {
	_, kind := nativeType()
	f := newFeed(t)
	f.stable = f.release("4.0.2", "v1.76.2", kind, artifactBytes(kind))
	f.beta = f.release("4.1.0-beta.1", "v1.77.0", kind, artifactBytes(kind))
	c, out, _ := testCLI(t, f, "4.0.1")
	if code := c.run(t, "--check"); code != 0 {
		t.Fatalf("--check = %d", code)
	}
	for _, want := range []string{
		"yours:  Rclone UI 4.0.1 (rclone ",
		"latest: Rclone UI 4.0.2 (rclone v1.76.2)",
		"(released 2026-10-01)",
		"upgrade: rclone update\n",
		"beta:   Rclone UI 4.1.0-beta.1 (rclone v1.77.0)",
		"upgrade: rclone update --beta",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("--check output lacks %q:\n%s", want, out)
		}
	}
	if f.downloads.Load() != 0 {
		t.Error("--check downloaded")
	}

	// With an action flag, --check reports what it would install.
	out.Reset()
	f.releases["4.0.0"] = f.release("4.0.0", "v1.75.1", kind, artifactBytes(kind))
	if code := c.run(t, "--check", "--version", "4.0.0"); code != 0 {
		t.Fatalf("--check --version = %d", code)
	}
	if !strings.Contains(out.String(), "Without --check this would install Rclone UI 4.0.0 (rclone v1.75.1) at ") {
		t.Errorf("--check --version said %q", out)
	}
}

func TestUpdateOutput(t *testing.T) {
	_, kind := nativeType()
	f := newFeed(t)
	content := artifactBytes(kind)
	f.stable = f.release("4.0.2", "v1.76.2", kind, content)
	c, out, errOut := testCLI(t, f, "4.0.1")
	dst := filepath.Join(t.TempDir(), "rcui-update")
	if code := c.run(t, "--output", dst); code != 0 {
		t.Fatalf("--output = %d: %s", code, errOut)
	}
	if b, err := os.ReadFile(dst); err != nil || !bytes.Equal(b, content) {
		t.Errorf("--output wrote %d bytes, %v", len(b), err)
	}
	if !strings.Contains(out.String(), "Downloaded Rclone UI 4.0.2 (rclone v1.76.2) at "+dst) {
		t.Errorf("--output said %q", out)
	}
}

func TestUpdateUpToDate(t *testing.T) {
	_, kind := nativeType()
	f := newFeed(t)
	f.stable = f.release("4.0.2", "v1.76.2", kind, artifactBytes(kind))
	c, out, _ := testCLI(t, f, "v4.0.2")
	if code := c.run(t); code != 0 || !strings.Contains(out.String(), "is up to date") {
		t.Errorf("up to date: %d %q", code, out)
	}
}

func TestUpdateHandsOffToTheApp(t *testing.T) {
	_, kind := nativeType()
	f := newFeed(t)
	f.stable = f.release("4.0.2", "v1.76.2", kind, artifactBytes(kind))
	f.beta = f.release("4.1.0-beta.1", "v1.77.0", kind, artifactBytes(kind))

	c, out, _ := testCLI(t, f, "4.0.1")
	c.appRunning = func() bool { return true }
	var gotVersion string
	var gotChannel Channel
	c.handOff = func(_ context.Context, version string, ch Channel) error {
		gotVersion, gotChannel = version, ch
		return nil
	}
	// The app is passed the release that the command announced, and the command's channel.
	for _, h := range []struct {
		flags   []string
		version string
		channel Channel
		said    string
	}{
		{[]string{"--beta"}, "4.1.0-beta.1", "beta", "Rclone UI is running; it will ask you to confirm the update to 4.1.0-beta.1 (rclone v1.77.0), then restart.\n"},
		{nil, "4.0.2", "stable", "Rclone UI is running; it will ask you to confirm the update to 4.0.2 (rclone v1.76.2), then restart.\n"},
	} {
		out.Reset()
		if code := c.run(t, h.flags...); code != 0 {
			t.Fatalf("hand-off %v = %d", h.flags, code)
		}
		if out.String() != h.said {
			t.Errorf("hand-off %v said %q, want %q", h.flags, out, h.said)
		}
		if gotVersion != h.version || gotChannel != h.channel {
			t.Errorf("hand-off %v: the app got %q on %q", h.flags, gotVersion, gotChannel)
		}
	}
	if f.downloads.Load() != 0 {
		t.Error("the command downloaded although the app updates")
	}

	// A failed hand-off doesn't stop the command, which continues by itself. Here it refuses to
	// replace the test binary, because no installer placed it.
	c.handOff = func(context.Context, string, Channel) error { return errors.New("the app didn't answer") }
	out.Reset()
	var errOut bytes.Buffer
	c.errOut = &errOut
	if code := c.run(t); code != exitError || !strings.Contains(errOut.String(), "No installer put") {
		t.Errorf("not handled: %d %q %q", code, out, errOut.String())
	}
	if !strings.Contains(errOut.String(), "rclone update --output PATH") {
		t.Errorf("no --output hint: %q", errOut.String())
	}
}

func TestUpdatePortable(t *testing.T) {
	_, kind := nativeType()
	f := newFeed(t)
	f.stable = f.release("4.0.2", "v1.76.2", kind, artifactBytes(kind))
	c, out, errOut := testCLI(t, f, "4.0.1")
	c.engine.Installed = TypePortable
	handed := false
	c.appRunning = func() bool { return true }
	c.handOff = func(context.Context, string, Channel) error { handed = true; return nil }
	page := "https://github.com/rclone/rclone-ui/releases/tag/v4.0.2"

	if code := c.run(t, "--check"); code != 0 {
		t.Fatalf("--check = %d", code)
	}
	for _, want := range []string{"yours:  Rclone UI 4.0.1 (rclone ", ") (portable)\n", "upgrade: " + page + "\n"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("--check output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out.String(), "rclone update") {
		t.Errorf("--check offers the update command:\n%s", out)
	}

	out.Reset()
	if code := c.run(t, "--check", "--stable"); code != 0 || !strings.Contains(out.String(), page) {
		t.Errorf("--check --stable: %d %q", code, out)
	}

	out.Reset()
	errOut.Reset()
	if code := c.run(t); code != exitError {
		t.Errorf("update = %d, want %d", code, exitError)
	}
	for _, want := range []string{PortableNote, "Rclone UI 4.0.2 (rclone v1.76.2) is on its release page: " + page} {
		if !strings.Contains(errOut.String(), want) {
			t.Errorf("update lacks %q:\n%s", want, errOut)
		}
	}
	if handed || f.downloads.Load() != 0 {
		t.Errorf("handed off %v, %d downloads", handed, f.downloads.Load())
	}

	// --output still downloads the release.
	dst := filepath.Join(t.TempDir(), "rcui-update")
	if code := c.run(t, "--output", dst); code != 0 || f.downloads.Load() != 1 {
		t.Errorf("--output = %d, %d downloads: %s", code, f.downloads.Load(), errOut)
	}
}

func TestInstallCommands(t *testing.T) {
	root := &cobra.Command{Use: "rclone"}
	rcloneOwn := &cobra.Command{Use: "selfupdate", Short: "Update the rclone binary.", Run: func(*cobra.Command, []string) {}}
	var versionRan, versionChecked bool
	versionCmd := &cobra.Command{Use: "version", RunE: func(cmd *cobra.Command, _ []string) error {
		versionRan = true
		versionChecked, _ = cmd.Flags().GetBool("check")
		return nil
	}}
	versionCmd.Flags().Bool("check", false, "Check for new version")
	versionCmd.Flags().Bool("deps", false, "Show the Go dependencies")
	root.AddCommand(rcloneOwn, versionCmd)

	f := newFeed(t)
	_, kind := nativeType()
	f.stable = f.release("4.0.2", "v1.76.2", kind, artifactBytes(kind))
	c, out, _ := testCLI(t, f, "4.0.1")
	c.install(root)
	c.install(root) // installing twice has the same effect as once

	// There is one update command (this app's), and one selfupdate command (the note that replaces
	// rclone's).
	named := map[string][]*cobra.Command{}
	for _, cmd := range root.Commands() {
		named[cmd.Name()] = append(named[cmd.Name()], cmd)
	}
	if s := named["selfupdate"]; len(s) != 1 || s[0] == rcloneOwn || s[0].Long != selfUpdateNote {
		t.Fatalf("selfupdate commands: %d, rclone's still there: %v", len(s), len(s) > 0 && s[0] == rcloneOwn)
	}
	if u := named["update"]; len(u) != 1 || u[0].Flags().Lookup("version") == nil {
		t.Fatalf("update commands: %d", len(u))
	}

	root.SetArgs([]string{"version", "--check"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if versionRan || !strings.Contains(out.String(), "latest: Rclone UI 4.0.2 (rclone v1.76.2)") {
		t.Errorf("version --check: rclone's ran %v, output %q", versionRan, out)
	}
	// cobra keeps flag values between runs, so reset --check.
	_ = versionCmd.Flags().Set("check", "false")
	root.SetArgs([]string{"version"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if !versionRan || versionChecked {
		t.Error("version alone isn't rclone's")
	}
	if !strings.Contains(versionCmd.Flags().Lookup("check").Usage, "Rclone UI") {
		t.Error("version --check's help isn't Rclone UI's")
	}
}

func TestInvokedAs(t *testing.T) {
	for in, want := range map[string]string{
		"/usr/local/bin/rclone":                              "rclone",
		`C:\Program Files\Rclone UI\rcui.exe`:                "rcui",
		"/Applications/Rclone UI.app/Contents/MacOS/rcui":    "rcui",
		`C:\Users\me\AppData\Local\Rclone UI\bin\RCLONE.EXE`: "RCLONE",
	} {
		// filepath.Base only splits on the host OS's separator.
		if runtime.GOOS != "windows" && strings.Contains(in, `\`) {
			continue
		}
		if got := invokedAs(in); got != want {
			t.Errorf("invokedAs(%q) = %q, want %q", in, got, want)
		}
	}
}
