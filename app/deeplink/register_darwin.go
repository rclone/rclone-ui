package deeplink

// Register does nothing on macOS. The bundle's Info.plist (CFBundleURLTypes) registers the scheme
// with Launch Services, so there is nothing to do at run time.
func Register(string) error { return nil }
