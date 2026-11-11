package app

import (
	"golang.org/x/sys/windows/registry"

	"github.com/rclone/rclone-ui/app/interaction"
	"github.com/rclone/rclone-ui/core/i18n"
)

const (
	// webView2Client is the key under which EdgeUpdate keeps the WebView2 runtime's version.
	webView2Client = `SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`
	// webView2Download is Microsoft's page for the WebView2 runtime's bootstrapper.
	webView2Download = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
)

// webView2Versions reads the pv values that Microsoft's guide lists: a per-machine install under
// HKLM, in both the registry's 32-bit view (WOW6432Node on 64-bit Windows) and its 64-bit view,
// and a per-user install under HKCU. A missing key or value is left out.
func webView2Versions() []string {
	var pvs []string
	for _, k := range []struct {
		root registry.Key
		view uint32
	}{
		{registry.LOCAL_MACHINE, registry.WOW64_32KEY},
		{registry.LOCAL_MACHINE, registry.WOW64_64KEY},
		{registry.CURRENT_USER, 0},
	} {
		key, err := registry.OpenKey(k.root, webView2Client, registry.QUERY_VALUE|k.view)
		if err != nil {
			continue
		}
		pv, _, err := key.GetStringValue("pv")
		_ = key.Close()
		if err == nil {
			pvs = append(pvs, pv)
		}
	}
	return pvs
}

// webView2Failed tells the user why the app can't show its windows, before Wails exits. When the
// WebView2 runtime is missing, it offers Microsoft's download. Otherwise it shows the failure.
// Wails calls this on its main thread, which can't show a window anymore. So the dialog is a plain
// message box (interaction.ShowPlain), which needs nothing from Wails.
func (u *ui) webView2Failed(cause error) {
	if !webView2Installed(webView2Versions()) {
		u.log.Error("the WebView2 runtime isn't installed")
		if interaction.ShowPlain(interaction.Dialog{
			Kind:  interaction.Error,
			Title: i18n.T("Rclone UI Needs WebView2"),
			Message: i18n.T("Rclone UI draws its windows with Microsoft Edge WebView2, which isn't installed on this computer.\n\n" +
				"Download and install WebView2, then open Rclone UI again."),
			// i18n: A button in a plain Windows message box, which keeps its width: keep it short.
			OK:     i18n.T("Download"),
			Cancel: i18n.T("Quit"),
		}) == interaction.AnswerOK {
			if err := u.openURL(webView2Download); err != nil {
				u.log.Error("could not open the WebView2 download", "error", err)
			}
		}
		return
	}
	interaction.ShowPlain(interaction.Dialog{
		Kind:  interaction.Error,
		Title: i18n.T("Rclone UI Can't Show Its Windows"),
		// i18n: %[1]s is the error from WebView2, and %[2]s the path of the app's log file.
		Message: i18n.T("Microsoft Edge WebView2, which Rclone UI draws its windows with, failed to start, so Rclone UI will quit.\n\n"+
			"%[1]s\n\nThe log has the details: %[2]s", cause, u.logs.Path()),
	})
}
