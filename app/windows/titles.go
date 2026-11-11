package windows

import "github.com/rclone/rclone-ui/core/i18n"

// Title returns the title of the window named name ("Settings", "Wizard") in the app's language.
// The window gets it when it is made, so its title bar never shows another language while its
// page loads. The pages hold the same titles (src/routes.ts) and set them again once they have
// loaded, which also follows a change of language. A test keeps the two lists the same.
//
// A window without a title of its own (the startup screen, the launcher) keeps its name.
func Title(name string) string {
	if title, ok := titleOf(name); ok {
		return title
	}
	return name
}

// titleOf returns the title of the window named name, and false for a name that isn't one of the
// app's titled windows.
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
