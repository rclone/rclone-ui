package logs

import (
	"context"
	"log/slog"
)

const (
	CompApp           = "app"
	CompUI            = "ui"
	CompDB            = "db"
	CompRclone        = "rclone"
	CompConfig        = "config"
	CompTransfers     = "transfers"
	CompMounts        = "mounts"
	CompServes        = "serves"
	CompChildren      = "children"
	CompNotifications = "notifications"
	CompTunnel        = "tunnel"
)

const (
	SubStartup     = "startup"
	SubShutdown    = "shutdown"
	SubOpen        = "open"
	SubMaintenance = "maintenance"
	SubCore        = "core"
	SubWatch       = "watch"
	SubSupervisor  = "supervisor"
)

// Logger returns slog's default logger with a component and subcomponent. The default is looked
// up at each call, so a logger that was made before the log became the default (such as a
// package variable) still writes to it.
func Logger(component, subcomponent string) *slog.Logger {
	return slog.New(deferred{}).With("component", component, "subcomponent", subcomponent)
}

type deferred struct {
	ops []func(slog.Handler) slog.Handler
}

func (d deferred) handler() slog.Handler {
	h := slog.Default().Handler()
	for _, op := range d.ops {
		h = op(h)
	}
	return h
}

func (d deferred) Enabled(ctx context.Context, level slog.Level) bool {
	return slog.Default().Handler().Enabled(ctx, level)
}

func (d deferred) Handle(ctx context.Context, r slog.Record) error {
	return d.handler().Handle(ctx, r)
}

func (d deferred) WithAttrs(attrs []slog.Attr) slog.Handler {
	return deferred{ops: append(d.ops[:len(d.ops):len(d.ops)], func(h slog.Handler) slog.Handler { return h.WithAttrs(attrs) })}
}

func (d deferred) WithGroup(name string) slog.Handler {
	return deferred{ops: append(d.ops[:len(d.ops):len(d.ops)], func(h slog.Handler) slog.Handler { return h.WithGroup(name) })}
}
