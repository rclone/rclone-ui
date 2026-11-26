package catalog

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"

	rclonecmd "github.com/rclone/rclone/cmd"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configflags"
	"github.com/rclone/rclone/fs/filter/filterflags"
	"github.com/rclone/rclone/fs/log/logflags"
	"github.com/rclone/rclone/fs/rc/rcflags"
	"github.com/spf13/pflag"
)

type cliFlag struct {
	Name, Short, Type string
	Option            bool
}

const cliFlagsLine = "RCUI-CLI-FLAGS "

// rcloneCLIFlags returns the global flags on rclone's command line in this binary (the flags
// that `rcui sync …` parses). They are read in a child process of the test, where rclone adds
// them to pflag.CommandLine as cmd.Main does (setupRootCommand's four AddFlags, then
// AddBackendFlags). That sets NoPrefix on the registry's options and would read RCLONE_* into
// rclone's globals. The child's environment has no RCLONE_* variables, and its changed state is
// thrown away when it exits.
func rcloneCLIFlags(t *testing.T) []cliFlag {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestCLIOnlyFlags$")
	home := t.TempDir()
	cmd.Env = []string{"RCUI_TEST_CLI_FLAGS=1", "HOME=" + home, "XDG_CONFIG_HOME=" + home, "TMPDIR=" + os.TempDir()}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("child: %v\n%s", err, out)
	}
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(nil, 16<<20)
	for sc.Scan() {
		if rest, ok := strings.CutPrefix(sc.Text(), cliFlagsLine); ok {
			var flags []cliFlag
			if err := json.Unmarshal([]byte(rest), &flags); err != nil {
				t.Fatal(err)
			}
			return flags
		}
	}
	t.Fatalf("child printed no flags:\n%s", out)
	return nil
}

func printCLIFlags(t *testing.T) {
	ci := fs.GetConfig(context.Background())
	configflags.AddFlags(ci, pflag.CommandLine)
	filterflags.AddFlags(pflag.CommandLine)
	rcflags.AddFlags(pflag.CommandLine)
	logflags.AddFlags(pflag.CommandLine)
	rclonecmd.AddBackendFlags()
	var flags []cliFlag
	pflag.CommandLine.VisitAll(func(f *pflag.Flag) {
		_, option := f.Value.(*fs.Option)
		flags = append(flags, cliFlag{Name: f.Name, Short: f.Shorthand, Type: f.Value.Type(), Option: option})
	})
	raw, err := json.Marshal(flags)
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout.WriteString("\n" + cliFlagsLine + string(raw) + "\n")
}

func TestCLIOnlyFlags(t *testing.T) {
	if os.Getenv("RCUI_TEST_CLI_FLAGS") == "1" {
		printCLIFlags(t)
		return
	}
	cli := rcloneCLIFlags(t)
	kinds := map[cliKind]string{cliBool: "bool", cliCount: "count", cliString: "string", cliList: "stringArray"}
	var own, theirs []string
	for _, c := range cliOnly {
		if c.name != "help" {
			own = append(own, c.name+"/"+c.short+"/"+kinds[c.kind])
		}
	}
	byName := map[string]cliFlag{}
	for _, f := range cli {
		byName[f.Name] = f
		if !f.Option {
			kind := f.Type
			if kind != "bool" && kind != "count" && kind != "stringArray" {
				kind = "string"
			}
			theirs = append(theirs, f.Name+"/"+f.Short+"/"+kind)
		}
	}
	slices.Sort(own)
	slices.Sort(theirs)
	if !slices.Equal(own, theirs) {
		t.Errorf("cliOnly (name/short/kind)\n %v\nrclone's command line\n %v", own, theirs)
	}

	set, flags := flagSet("")
	for name, fo := range flags {
		global := fo.backend
		switch fo.block {
		case "main", "filter", "rc", "log":
			global = true
		}
		if !global {
			continue
		}
		f, ok := byName[name]
		if !ok || !f.Option {
			t.Errorf("--%s (%s.%s) is no flag of rclone's command line", name, fo.block, fo.opt.Name)
			continue
		}
		if short := set.Lookup(name).Shorthand; short != "" && short != f.Short {
			t.Errorf("--%s is -%s here, -%s in rclone", name, short, f.Short)
		}
	}
	for _, f := range cli {
		if f.Option && set.Lookup(f.Name) == nil {
			t.Errorf("rclone's --%s is not known here", f.Name)
		}
	}
}
