package logs

import (
	"context"
	"path/filepath"

	"github.com/rclone/rclone-ui/core/internal/late"
)

// LogRecord is one line of the log, in the form the About page shows.
type LogRecord struct {
	N int64 `json:"n"`
	// Time is when the line was written, in ms since the epoch.
	Time         int64  `json:"time"`
	Level        string `json:"level"`
	Component    string `json:"component"`
	Subcomponent string `json:"subcomponent"`
	Message      string `json:"message"`
	Object       string `json:"object"`
	Transfer     string `json:"transfer"`
	Operation    string `json:"operation"`
	Mark         string `json:"mark"`
	Count        int64  `json:"count"`
}

// Files holds the paths of the log file and its folder.
type Files struct {
	Core   string `json:"core"`
	Folder string `json:"folder"`
}

type API struct{ l *late.Value[*Log] }

func NewAPI(l *late.Value[*Log]) *API { return &API{l: l} }

// Tail returns at most limit of the newest records in memory, oldest first.
func (a *API) Tail(ctx context.Context, limit int) ([]LogRecord, error) {
	return late.Call(ctx, a.l, func(l *Log) ([]LogRecord, error) { return tail(l, limit), nil })
}

func tail(l *Log, limit int) []LogRecord {
	records := l.Tail(limit)
	out := make([]LogRecord, 0, len(records))
	for _, r := range records {
		out = append(out, LogRecord{
			N: r.N, Time: r.Time.UnixMilli(), Level: LevelWord(r.Level),
			Component: r.Component, Subcomponent: r.Subcomponent, Message: r.Message,
			Object: r.Object, Transfer: r.Transfer, Operation: r.Operation, Mark: r.Mark, Count: r.Count,
		})
	}
	return out
}

func (a *API) Files(ctx context.Context) (Files, error) {
	return late.Call(ctx, a.l, func(l *Log) (Files, error) {
		return Files{Core: l.Path(), Folder: filepath.Dir(l.Path())}, nil
	})
}
