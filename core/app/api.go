package app

import (
	"context"
	"os"
	"runtime"
	"time"

	"github.com/rclone/rclone-ui/core/version"
)

type Info struct {
	AppVersion    string `json:"appVersion"`
	RcloneVersion string `json:"rcloneVersion"`
	Arch          string `json:"arch"`
	GoVersion     string `json:"goVersion"`
	// StartedAt is when the app started, in milliseconds since the epoch.
	StartedAt int64  `json:"startedAt"`
	DataDir   string `json:"dataDir"`
	PID       int    `json:"pid"`
}

var started = time.Now()

type API struct{ info Info }

func NewAPI(dataDir string) *API {
	return &API{info: Info{
		AppVersion:    version.App,
		RcloneVersion: version.Rclone(),
		Arch:          runtime.GOARCH,
		GoVersion:     runtime.Version(),
		StartedAt:     started.UnixMilli(),
		DataDir:       dataDir,
		PID:           os.Getpid(),
	}}
}

func (a *API) Info(context.Context) (Info, error) { return a.info, nil }
