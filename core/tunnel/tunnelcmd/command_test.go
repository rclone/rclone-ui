package tunnelcmd

import (
	"context"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs/rc"
	"github.com/spf13/cobra"
)

// TestRefusedCommand checks that a phone's core/command can't run the updater, however the call
// writes it: in any case, with spaces around it, by selfupdate's alias, or after a flag and its
// value, where the subprocess's cobra would find it. Other commands run, and so does an argument
// with the same name.
func TestRefusedCommand(t *testing.T) {
	root := &cobra.Command{Use: "rcui"}
	root.PersistentFlags().Int("retries", 3, "")
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().BoolP("progress", "P", false, "")
	root.PersistentFlags().CountP("verbose", "v", "")
	for _, c := range []*cobra.Command{
		{Use: "update", Run: func(*cobra.Command, []string) {}},
		{Use: "selfupdate", Aliases: []string{"self-update"}, Run: func(*cobra.Command, []string) {}},
		{Use: "cat", Run: func(*cobra.Command, []string) {}},
	} {
		root.AddCommand(c)
	}
	for _, args := range [][]string{
		{"update"}, {" Update "}, {"SELFUPDATE", "--check"}, {"self-update"}, {"\tSelf-Update\n"},
		{"--retries", "3", "update"}, {"--dry-run", "selfupdate"}, {"--retries=1", "UPDATE", "--output", "/tmp/x"},
		// Lowercased, -P would be a flag that takes the next word as its value.
		{"-P", "update"}, {"-P", "selfupdate"}, {"-vP", "update", "--version", "4.0.0"},
	} {
		if got := refusedCommand(root, args); got == "" {
			t.Errorf("%q runs", args)
		}
	}
	for _, args := range [][]string{
		{"cat", "phone:update"}, {"cat", "update"}, {"cat", "--retries", "1", "selfupdate"},
		{"lsf", "update"}, {"--", "update"}, {}, {"updater"},
	} {
		if got := refusedCommand(root, args); got != "" {
			t.Errorf("%q refused as %s", args, got)
		}
	}

	// The app's own roles, which main checks before rclone's commands, are refused as the first
	// word.
	for _, args := range [][]string{
		{"ui"}, {" UI "}, {"metadata-map"}, {"mcp"}, {"MCP", "--data-dir", "/tmp/x"}, {"rclone://add-template?cmd=x"},
		{"RCLONE:add-template"}, {"-psn_0_12345"},
	} {
		if got := refusedCommand(root, args); got == "" {
			t.Errorf("%q runs", args)
		}
	}
	for _, args := range [][]string{{"cat", "ui"}, {"cat", "rclone://x"}} {
		if got := refusedCommand(root, args); got != "" {
			t.Errorf("%q refused as %s", args, got)
		}
	}
	if _, err := runCommand(context.Background(), rc.Params{"command": "ui"}); err == nil ||
		!strings.Contains(err.Error(), "does not run ui") {
		t.Fatalf("core/command ui: %v", err)
	}

	// The rc call explains why, and runs nothing.
	out, err := runCommand(context.Background(), rc.Params{"command": " SelfUpdate ", "arg": []string{"--check"}})
	if out != nil || err == nil || !strings.Contains(err.Error(), "does not run selfupdate") {
		t.Fatalf("core/command selfupdate: %v %v", out, err)
	}
}
