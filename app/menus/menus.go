// Package menus sets up the macOS menu bar. It replaces Wails' default menu, whose View › Reload
// (⌘R) would reload a page while the user is working in it. Wails' role menus have English
// labels, so the items get the app's own labels and keep their roles, which give them the same
// AppKit action and shortcut as Wails' own items.
package menus

import (
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/core/i18n"
)

const appName = "Rclone UI"

func Set(app *application.App) {
	if runtime.GOOS != "darwin" {
		return
	}
	app.Menu.SetApplicationMenu(bar(app))
}

func bar(app *application.App) *application.Menu {
	return application.NewMenuFromItems(appMenu(app), editMenu(), windowMenu())
}

func item(label string, role application.Role, accelerator string) *application.MenuItem {
	it := application.NewMenuItem(label).SetRole(role)
	if accelerator != "" {
		it.SetAccelerator(accelerator)
	}
	return it
}

func submenu(label string, items ...*application.MenuItem) *application.MenuItem {
	return application.NewSubmenu(label, application.NewMenuFromItems(items[0], items[1:]...))
}

// macOS titles the App menu with the app's name whatever its label.
func appMenu(app *application.App) *application.MenuItem {
	// macOS fills the Services menu itself, in the system's language.
	services := application.NewSubmenu(i18n.T("Services"), application.NewMenu()).SetRole(application.ServicesMenu)
	return submenu(appName,
		// i18n: A menu item that shows the app's About panel. %s is the app's name.
		item(i18n.T("About %s", appName), application.About, "").OnClick(func(*application.Context) { app.Menu.ShowAbout() }),
		application.NewMenuItemSeparator(),
		services,
		application.NewMenuItemSeparator(),
		// i18n: A menu item that hides the app's windows. %s is the app's name.
		item(i18n.T("Hide %s", appName), application.Hide, "CmdOrCtrl+h"),
		item(i18n.T("Hide Others"), application.HideOthers, "CmdOrCtrl+OptionOrAlt+h"),
		// Wails gives Show All the UnHide role, which has no action. ShowAll's is AppKit's
		// unhideAllApplications:.
		item(i18n.T("Show All"), application.ShowAll, ""),
		application.NewMenuItemSeparator(),
		// i18n: A menu item that quits the app. %s is the app's name.
		item(i18n.T("Quit %s", appName), application.Quit, "CmdOrCtrl+q").OnClick(func(*application.Context) { app.Quit() }),
	)
}

func editMenu() *application.MenuItem {
	speech := submenu(i18n.T("Speech"),
		item(i18n.T("Start Speaking"), application.StartSpeaking, "CmdOrCtrl+OptionOrAlt+Shift+."),
		item(i18n.T("Stop Speaking"), application.StopSpeaking, "CmdOrCtrl+OptionOrAlt+Shift+,"),
	)
	return submenu(i18n.TC("menu bar", "Edit"),
		item(i18n.T("Undo"), application.Undo, "CmdOrCtrl+z"),
		item(i18n.T("Redo"), application.Redo, "CmdOrCtrl+Shift+z"),
		application.NewMenuItemSeparator(),
		// i18n: The Edit menu's item that cuts the selection.
		item(i18n.T("Cut"), application.Cut, "CmdOrCtrl+x"),
		// i18n: The Edit menu's item that copies the selection to the clipboard.
		item(i18n.TC("menu bar", "Copy"), application.Copy, "CmdOrCtrl+c"),
		item(i18n.T("Paste"), application.Paste, "CmdOrCtrl+v"),
		item(i18n.T("Paste and Match Style"), application.PasteAndMatchStyle, "CmdOrCtrl+OptionOrAlt+Shift+v"),
		// i18n: The Edit menu's item that deletes the selection.
		item(i18n.T("Delete"), application.Delete, "backspace"),
		item(i18n.T("Select All"), application.SelectAll, "CmdOrCtrl+a"),
		application.NewMenuItemSeparator(),
		speech,
	)
}

func windowMenu() *application.MenuItem {
	// i18n: The Window menu of the menu bar.
	return submenu(i18n.T("Window"),
		item(i18n.T("Minimize"), application.Minimise, "CmdOrCtrl+M"),
		// i18n: The Window menu's item that resizes the window to fit its content, as macOS names it.
		item(i18n.T("Zoom"), application.Zoom, ""),
		// i18n: The Window menu's item that closes the window.
		item(i18n.T("Close"), application.CloseWindow, "CmdOrCtrl+w"),
		application.NewMenuItemSeparator(),
		// Wails gives Bring All to Front the Front role, which has no action. BringAllToFront's is
		// AppKit's arrangeInFront:.
		item(i18n.T("Bring All to Front"), application.BringAllToFront, ""),
	)
}
