//go:build !linux

package launcher

import (
	"log/slog"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// newBinder returns Wails' global shortcuts. On macOS and Windows the process that received the
// hotkey can take the focus without a token.
func newBinder(app *application.App, _ *slog.Logger) binder { return wailsBinder{app} }
