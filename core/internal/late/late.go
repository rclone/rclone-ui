// Package late provides a value that is set once, possibly after the pages have already asked for
// it. The shell binds the core's APIs before the core starts, so a call that arrives early waits
// for its service. Call and Do wait for the service and then run the call.
package late

import (
	"context"
	"fmt"
	"sync"

	"github.com/rclone/rclone-ui/core/errs"
)

// Value is a value that is set once, later. Get waits for it.
type Value[T any] struct {
	once  sync.Once
	ready chan struct{}
	v     T
	err   error
}

// New creates an unset value.
func New[T any]() *Value[T] { return &Value[T]{ready: make(chan struct{})} }

// Set sets the value. Only the first call to Set or Fail counts.
func (l *Value[T]) Set(v T) {
	l.once.Do(func() {
		l.v = v
		close(l.ready)
	})
}

// Fail records that the value will never be set. Get then returns err as Unavailable.
func (l *Value[T]) Fail(err error) {
	l.once.Do(func() {
		l.err = err
		close(l.ready)
	})
}

// Ready returns the value when it is already set, and false while it isn't or when Fail was
// called. It never waits.
func (l *Value[T]) Ready() (T, bool) {
	select {
	case <-l.ready:
		return l.v, l.err == nil
	default:
		var zero T
		return zero, false
	}
}

// Get waits for the value until ctx ends. If Fail was called, it returns an Unavailable error.
func (l *Value[T]) Get(ctx context.Context) (T, error) {
	select {
	case <-l.ready:
		if l.err != nil {
			var zero T
			return zero, errs.Unavailable(fmt.Errorf("Rclone UI's core didn't start: %w", l.err))
		}
		return l.v, nil
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	}
}

// Call waits for v's value and calls fn with it. It is the body of most API methods, which
// return fn's result and error unchanged: the shell gives every error its code
// (rclone.ErrorOf).
func Call[S, T any](ctx context.Context, v *Value[S], fn func(S) (T, error)) (T, error) {
	s, err := v.Get(ctx)
	if err != nil {
		var zero T
		return zero, err
	}
	return fn(s)
}

// CallValue is Call for a service method that returns a pointer. The pages get the value it
// points to, because none of these results is ever missing: a nil pointer comes back as T's
// zero value.
func CallValue[S, T any](ctx context.Context, v *Value[S], fn func(S) (*T, error)) (T, error) {
	p, err := Call(ctx, v, fn)
	if p == nil {
		var zero T
		return zero, err
	}
	return *p, err
}

// CallValues is Call for a service method that returns a list of pointers. The pages get a list
// of values, which is empty rather than nil when there are none.
func CallValues[S, T any](ctx context.Context, v *Value[S], fn func(S) ([]*T, error)) ([]T, error) {
	ps, err := Call(ctx, v, fn)
	if err != nil {
		return nil, err
	}
	return Values(ps), nil
}

// Values returns the values that ps points to, skipping nil pointers. It returns an empty list,
// not nil, when there are none.
func Values[T any](ps []*T) []T {
	out := make([]T, 0, len(ps))
	for _, p := range ps {
		if p != nil {
			out = append(out, *p)
		}
	}
	return out
}

// Do waits for the value and calls fn with it, as Call does for a function without a result.
func (l *Value[T]) Do(ctx context.Context, fn func(T) error) error {
	v, err := l.Get(ctx)
	if err != nil {
		return err
	}
	return fn(v)
}

// Of returns a value that is already set to v. Tests use it to give an API a running service.
func Of[T any](v T) *Value[T] {
	l := New[T]()
	l.Set(v)
	return l
}
