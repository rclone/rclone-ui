package deeplink

import (
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// Register makes exe open rclone:// links for this user (in HKCU\Software\Classes\rclone). It runs
// at every start, so per-user installs and portable copies get links without an installer. When
// a machine has several copies, the one that started last opens the links. The NSIS installer's
// own entry, which is per machine, is left alone.
func Register(exe string) error {
	root, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Classes\`+Scheme, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	if err := root.SetStringValue("", "URL:"+Scheme+" protocol"); err != nil {
		return err
	}
	if err := root.SetStringValue("URL Protocol", ""); err != nil {
		return err
	}
	icon, _, err := registry.CreateKey(root, "DefaultIcon", registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer func() { _ = icon.Close() }()
	if err := icon.SetStringValue("", fmt.Sprintf(`"%s",0`, exe)); err != nil {
		return err
	}
	cmd, _, err := registry.CreateKey(root, `shell\open\command`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer func() { _ = cmd.Close() }()
	return cmd.SetStringValue("", fmt.Sprintf(`"%s" "%%1"`, exe))
}
