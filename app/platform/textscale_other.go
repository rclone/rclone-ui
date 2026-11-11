//go:build !windows

package platform

// TextScale is 1 where the app's windows aren't enlarged by a text size setting.
func TextScale() float64 { return 1 }
