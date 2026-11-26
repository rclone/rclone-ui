package windows

import "github.com/rclone/rclone-ui/core/i18n"

func Title(name string) string {
	if title, ok := titleOf(name); ok {
		return title
	}
	return name
}

func titleOf(name string) (string, bool) {
	switch name {
	case "Settings":
		return i18n.T("Settings"), true
	case "Remotes":
		return i18n.T("Remotes"), true
	case "Notifications":
		return i18n.T("Notifications"), true
	case "MobileRemoteControl":
		return i18n.T("Mobile & Remote Control"), true
	case "Sync":
		return i18n.T("Sync"), true
	case "Copy":
		return i18n.T("Copy"), true
	case "Move":
		return i18n.T("Move"), true
	case "Delete":
		return i18n.T("Delete"), true
	case "Purge":
		return i18n.T("Purge"), true
	case "Download":
		return i18n.T("Download"), true
	case "Serve":
		return i18n.T("Serve"), true
	case "Bisync":
		return i18n.T("Bisync"), true
	case "Commander":
		return i18n.T("Commander"), true
	case "Mount":
		return i18n.T("Mount"), true
	case "History":
		return i18n.T("History"), true
	case "Templates":
		return i18n.T("Templates"), true
	case "Watchers":
		return i18n.T("Watchers"), true
	case "Schedules":
		return i18n.T("Schedules"), true
	case "Automounts":
		return i18n.T("Automounts"), true
	case "Wizard":
		// i18n: The title of the window that asks what to do and finds the operation for it.
		return i18n.T("Run"), true
	case "Guides":
		return i18n.T("Guides"), true
	}
	return "", false
}
