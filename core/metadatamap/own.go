package metadatamap

import "path/filepath"

const Subcommand = "metadata-map"

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

func Runnable(argv []string, exe string) []string {
	if len(argv) > 0 && argv[0] == Subcommand {
		return append([]string{exe}, argv...)
	}
	return argv
}
