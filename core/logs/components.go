package logs

import (
	"context"
	"log/slog"
)

// The components. They are a fixed list, so the lines of one area can be picked out of the file.
const (
	CompApp           = "app"
	CompUI            = "ui" // the windows, the tray, the launcher, the pages' console lines
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

// The fixed subcomponents. Other subcomponents are not fixed: rclone's lines use the backend's
// name (or SubCore when there is none), a mount's lines use its mount point, and a serve's lines
// use `<type>:<addr>`.
const (
	// app
	SubStartup  = "startup"
	SubShutdown = "shutdown"
	// db
	SubOpen        = "open"
	SubMaintenance = "maintenance"
	// rclone
	SubCore = "core"
	// config
	SubWatch = "watch"
	// children
	SubSupervisor = "supervisor"
)

// Logger returns slog's default logger with a component and subcomponent. The default is looked
// up at each call, so a logger that was made before the log became the default (such as a
// package variable) still writes to it.
func Logger(component, subcomponent string) *slog.Logger {
	return slog.New(deferred{}).With("component", component, "subcomponent", subcomponent)
}

// deferred passes every record to the handler of slog.Default at the time it is logged.
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
