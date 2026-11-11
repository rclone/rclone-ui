package childenv

// IgnoreSIGPIPE does nothing on Windows. Windows has no SIGPIPE, and a write to a closed pipe
// already returns an error there.
func IgnoreSIGPIPE() {}
