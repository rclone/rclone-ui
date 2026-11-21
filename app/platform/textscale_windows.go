package platform

import "golang.org/x/sys/windows/registry"

// TextScale returns Windows' text size setting (Settings > Accessibility > Text size) as a factor
// from 1 to 2.25. WebView2 enlarges a whole page by it, on top of the display's scale, so a window
// has to grow by it too or its page is cut off.
func TextScale() float64 {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Accessibility`, registry.QUERY_VALUE)
	if err != nil {
		return 1
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("TextScaleFactor")
	if err != nil || v < 100 || v > 225 {
		return 1
	}
	return float64(v) / 100
}
