package telemetry

import (
	"context"
	"log/slog"
)

// TapPanics returns a handler that passes every record on to h. It also calls report for each
// record that logs a recovered panic: an error with the panic's stack in its "stack" attribute,
// which is how every recover in the app logs one. report gets the logger's "component", the
// panic's value (the "panic" attribute, or the message when there is none) and the stack.
func TapPanics(h slog.Handler, report func(source, value, stack string)) slog.Handler {
	return tap{Handler: h, report: report}
}

type tap struct {
	slog.Handler
	component string
	report    func(source, value, stack string)
}

func (t tap) Handle(ctx context.Context, r slog.Record) error {
	if r.Level >= slog.LevelError {
		value, stack, component := "", "", t.component
		r.Attrs(func(a slog.Attr) bool {
			switch a.Key {
			case "panic":
				value = a.Value.String()
			case "stack":
				stack = a.Value.String()
			case "component":
				component = a.Value.String()
			}
			return true
		})
		if stack != "" {
			if value == "" {
				value = r.Message
			}
			t.report(component, value, stack)
		}
	}
	return t.Handler.Handle(ctx, r)
}

func (t tap) WithAttrs(attrs []slog.Attr) slog.Handler {
	t.Handler = t.Handler.WithAttrs(attrs)
	for _, a := range attrs {
		if a.Key == "component" {
			t.component = a.Value.String()
		}
	}
	return t
}

func (t tap) WithGroup(name string) slog.Handler {
	t.Handler = t.Handler.WithGroup(name)
	return t
}
