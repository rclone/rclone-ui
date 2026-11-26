// rcui.exe is a GUI program, so when it runs from a terminal the prompt comes back at once. This
// console program runs ..\rcui.exe with argv[0] set to "rclone" and the terminal's handles, waits
// for it, and exits with its exit code. As a result, `rclone …` in a terminal behaves like the
// real rclone.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
)

func main() {
	os.Exit(run())
}

func run() int {
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "rclone:", err)
		return 1
	}
	rcui := filepath.Join(filepath.Dir(filepath.Dir(self)), "rcui.exe")
	cmd := exec.Command(rcui, os.Args[1:]...)
	cmd.Args[0] = "rclone"
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	// Ctrl+C reaches every process on the console. rcui handles it the way rclone does, and this
	// process ignores it so that it waits for rcui instead of leaving it behind.
	signal.Ignore(os.Interrupt)
	err = cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit):
		return exit.ExitCode()
	}
	fmt.Fprintf(os.Stderr, "rclone: could not run %s: %v\n", rcui, err)
	return 1
}
