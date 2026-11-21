package pathlink

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

// macLink is the link's path. It is on the default PATH (/etc/paths) and on root's PATH.
const macLink = "/usr/local/bin/rclone"

func newLinker() (*Linker, error) {
	data, err := datadir.Default()
	if err != nil {
		return nil, err
	}
	exe, err := platform.Executable()
	if err != nil {
		return nil, err
	}
	l := &Linker{
		exe:     exe,
		link:    macLink,
		pointer: filepath.Join(data, "bin", "rclone"),
		path:    envPath,
		asAdmin: runAsAdmin,
	}
	if strings.Contains(exe, "/AppTranslocation/") {
		l.unsupported = i18n.M("macOS runs this Rclone UI from a temporary copy: move it to Applications and open it from there first.")
	}
	return l, nil
}

func runAsAdmin(shellCmd, prompt string) error {
	esc := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	script := fmt.Sprintf(`do shell script "%s" with administrator privileges with prompt "%s"`,
		esc.Replace(shellCmd), esc.Replace(prompt))
	out, err := exec.Command("/usr/bin/osascript", "-e", script).CombinedOutput()
	if err != nil {
		if strings.Contains(string(out), "-128") {
			return errs.New("The administrator prompt was cancelled.")
		}
		return errs.Errorf("The administrator prompt failed: %s", strings.TrimSpace(string(out)))
	}
	return nil
}
