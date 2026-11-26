package update

import "runtime"

type InstallType string

const (
	TypeApp       InstallType = "app"
	TypeNSIS      InstallType = "nsis"
	TypeAppImage  InstallType = "appimage"
	TypeDeb       InstallType = "deb"
	TypeRPM       InstallType = "rpm"
	TypeFlatpak   InstallType = "flatpak"
	TypePortable  InstallType = "portable"
	TypeUnmanaged InstallType = "unmanaged"
)

const uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\org.rclone.ui`

type Kind string

const (
	KindApp      Kind = "app"
	KindNSIS     Kind = "nsis"
	KindAppImage Kind = "appimage"
	KindDeb      Kind = "deb"
	KindRPM      Kind = "rpm"
)

func (t InstallType) kind() Kind {
	switch t {
	case TypeApp:
		return KindApp
	case TypeNSIS:
		return KindNSIS
	case TypeAppImage:
		return KindAppImage
	case TypeDeb:
		return KindDeb
	case TypeRPM:
		return KindRPM
	}
	return ""
}

func defaultKind(goos string) Kind {
	switch goos {
	case "darwin":
		return KindApp
	case "windows":
		return KindNSIS
	case "linux":
		return KindAppImage
	}
	return ""
}

func (e *Engine) artifactKind() (Kind, error) {
	switch e.opts.Package {
	case "deb", "rpm":
		if runtime.GOOS != "linux" {
			return "", errPackageNotLinux
		}
		return Kind(e.opts.Package), nil
	case "":
	default:
		return "", errPackageValue
	}
	if k := e.InstallType().kind(); k != "" {
		return k, nil
	}
	return defaultKind(runtime.GOOS), nil
}
