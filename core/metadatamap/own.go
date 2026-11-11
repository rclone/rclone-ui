package metadatamap

import "path/filepath"

// Subcommand is the subcommand of the app's own metadata mapper. rclone's `metadata_mapper`
// option runs this executable with the subcommand, followed by the rules.
const Subcommand = "metadata-map"

// Own returns argv without the executable path (`["metadata-map", …rules]`) when argv runs the
// app's own mapper. That means the subcommand, optionally preceded by exe, and then only valid
// rules. Anything else is treated as an ordinary program: another program, another subcommand of
// this binary, or extra arguments after the rules. exe may be "", and then only the subcommand
// form counts.
func Own(argv []string, exe string) ([]string, bool) {
	if len(argv) > 0 && argv[0] != Subcommand && sameExecutable(argv[0], exe) {
		argv = argv[1:]
	}
	if len(argv) == 0 || argv[0] != Subcommand {
		return nil, false
	}
	if _, err := ParseArgs(argv[1:]); err != nil {
		return nil, false
	}
	return argv, true
}

// sameExecutable reports whether program is exe, written the same way or through a link.
func sameExecutable(program, exe string) bool {
	if exe == "" || program == "" {
		return false
	}
	if filepath.Clean(program) == filepath.Clean(exe) {
		return true
	}
	a, errA := filepath.EvalSymlinks(program)
	b, errB := filepath.EvalSymlinks(exe)
	return errA == nil && errB == nil && a == b
}

// Runnable returns a stored mapper value ready to run. The app's own mapper gets the running
// executable exe in front, so a template saved before the binary moved still runs the current
// one. Any other value is returned unchanged.
func Runnable(argv []string, exe string) []string {
	if len(argv) > 0 && argv[0] == Subcommand {
		return append([]string{exe}, argv...)
	}
	return argv
}
