package app

import (
	"context"
	"github.com/rclone/rclone-ui/core/agents"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/app/launcher/view/linux"
	"github.com/rclone/rclone-ui/app/pathlink"
	"github.com/rclone/rclone-ui/app/windows"
	"github.com/rclone/rclone-ui/core/browse"
	"github.com/rclone/rclone-ui/core/bus"
)

// The events that the UI sends to the pages. lib/shell listens for them.
const (
	// EventCoreState carries the core's status (CoreStatus) on every change.
	EventCoreState = "core:state"
	// EventUpdateState reports the progress of the update flow (UpdateState).
	EventUpdateState = "update:state"
	// EventAutostartChanged carries whether the app starts at login, after a window changed it.
	// The other windows that show the switch then update. A change made in the OS's own settings
	// sends nothing, and the pages read it again when their window gets the focus.
	EventAutostartChanged = "autostart:changed"
	// EventPathLinkChanged carries the state of "Add rclone to PATH" (pathlink.State), after a
	// window turned it on or off.
	EventPathLinkChanged = "pathlink:changed"
	// EventAgentsChanged carries the state of the agents' server (agents.Status), after it
	// started, stopped or failed to start.
	EventAgentsChanged = "agents:changed"
)

// The events are registered with their data types, so that the generated bindings give the pages
// typed events. The core's events are its bus events, each with the payload that its publisher
// puts on the bus. The last ones are events that a call sends back to the window that made it,
// such as a listing's rows.
func init() {
	application.RegisterEvent[CoreStatus](EventCoreState)
	application.RegisterEvent[string](windows.EventRoute)
	application.RegisterEvent[application.Void](windows.EventCloseAsked)
	application.RegisterEvent[UpdateState](EventUpdateState)
	application.RegisterEvent[bool](EventAutostartChanged)
	application.RegisterEvent[pathlink.State](EventPathLinkChanged)
	application.RegisterEvent[agents.Status](EventAgentsChanged)
	application.RegisterEvent[linux.Frame](linux.EventRender)
	application.RegisterEvent[linux.Query](linux.EventQuery)
	application.RegisterEvent[application.Void](linux.EventShown)
	application.RegisterEvent[application.Void](linux.EventHidden)

	application.RegisterEvent[application.Void](bus.Resync)
	application.RegisterEvent[bus.TransfersChangedData](bus.TransfersChanged)
	application.RegisterEvent[bus.TransfersProgressData](bus.TransfersProgress)
	application.RegisterEvent[bus.RemotesChangedData](bus.RemotesChanged)
	application.RegisterEvent[bus.RemotesHealthData](bus.RemotesHealth)
	application.RegisterEvent[bus.RemotesSessionData](bus.RemotesSession)
	application.RegisterEvent[bus.MountsChangedData](bus.MountsChanged)
	application.RegisterEvent[bus.ServesChangedData](bus.ServesChanged)
	application.RegisterEvent[application.Void](bus.TemplatesChanged)
	application.RegisterEvent[application.Void](bus.WatchersChanged)
	application.RegisterEvent[application.Void](bus.SchedulesChanged)
	application.RegisterEvent[application.Void](bus.AutomountsChanged)
	application.RegisterEvent[application.Void](bus.FavoritesChanged)
	application.RegisterEvent[application.Void](bus.NotificationsChanged)
	application.RegisterEvent[application.Void](bus.SettingsChanged)
	application.RegisterEvent[bus.PrefsChangedData](bus.PrefsChanged)
	application.RegisterEvent[application.Void](bus.ConfigChanged)
	application.RegisterEvent[bus.TunnelChangedData](bus.TunnelChanged)
	application.RegisterEvent[bus.FilesChangedData](bus.FilesChanged)

	application.RegisterEvent[browse.Rows](browse.EventRows)
	application.RegisterEvent[browse.FolderSize](browse.EventSize)
	application.RegisterEvent[browse.UsageProgress](browse.EventUsage)
}

// relayCoreEvent passes one of the core's events on to every window, with its payload unchanged.
// Desktop notifications are handled by the UI alone, so the windows don't get them.
func (u *ui) relayCoreEvent(ev bus.Event) {
	if ev.Name == bus.NotifyOS {
		return
	}
	if ev.Data == nil {
		u.app.Event.Emit(ev.Name)
		return
	}
	u.app.Event.Emit(ev.Name, ev.Data)
}

// emitToCaller sends an event from a call to the window that made the call (ctx is the call's
// context). When the call didn't come from a window, the event goes to every window.
func (u *ui) emitToCaller(ctx context.Context, name string, data any) {
	if w, ok := windows.Caller(ctx); ok {
		w.DispatchWailsEvent(&application.CustomEvent{Name: name, Data: data})
		return
	}
	u.app.Event.Emit(name, data)
}

type CoreStatus struct {
	State CoreState `json:"state"`
	// Error explains why the core is not ready.
	Error   string `json:"error"`
	Version string `json:"version"`
}

type UpdateState struct {
	// Phase is "idle", "checking", "downloading", "installing" or "error".
	Phase   string `json:"phase"`
	Version string `json:"version"`
	// Done and Total count the download's bytes. Total is 0 when unknown.
	Done  int64  `json:"done"`
	Total int64  `json:"total"`
	Error string `json:"error"`
}
