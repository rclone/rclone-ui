package late

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/errs"
)

func TestGetWaitsForSet(t *testing.T) {
	v := New[int]()
	got := make(chan int)
	go func() {
		n, err := v.Get(context.Background())
		if err != nil {
			t.Error(err)
		}
		got <- n
	}()
	time.Sleep(10 * time.Millisecond)
	v.Set(7)
	v.Set(8) // only the first call counts
	if n := <-got; n != 7 {
		t.Fatalf("got %d", n)
	}
}

func TestFailAndCancel(t *testing.T) {
	v := New[int]()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := v.Get(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled wait: %v", err)
	}
	v.Fail(errors.New("the database is newer"))
	if _, err := v.Get(context.Background()); errs.Of(err).Code != errs.CodeUnavailable {
		t.Fatalf("a failed start: %v", err)
	}
	if err := v.Do(context.Background(), func(int) error { panic("called") }); errs.Of(err).Code != errs.CodeUnavailable {
		t.Fatalf("Do after a failed start: %v", err)
	}
}

// Call and Do pass the value to fn and return fn's result and error unchanged.
func TestCallAndDo(t *testing.T) {
	ctx := context.Background()
	v := Of(3)
	n, err := Call(ctx, v, func(n int) (string, error) { return strings.Repeat("x", n), nil })
	if n != "xxx" || err != nil {
		t.Fatalf("Call: %q %v", n, err)
	}
	refused := errs.New("No.")
	if err := v.Do(ctx, func(int) error { return refused }); err != refused {
		t.Fatalf("Do: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := Call(cancelled, New[int](), func(int) (int, error) { panic("called") }); !errors.Is(err, context.Canceled) {
		t.Fatalf("Call before Set: %v", err)
	}
}

// CallValue and CallValues give the pages values in place of the services' pointers.
func TestCallValue(t *testing.T) {
	ctx := context.Background()
	v := Of("s")
	n := 3
	if got, err := CallValue(ctx, v, func(string) (*int, error) { return &n, nil }); err != nil || got != 3 {
		t.Errorf("a pointer: %d %v", got, err)
	}
	refused := errors.New("refused")
	if got, err := CallValue(ctx, v, func(string) (*int, error) { return nil, refused }); err != refused || got != 0 {
		t.Errorf("an error: %d %v", got, err)
	}
	got, err := CallValues(ctx, v, func(string) ([]*int, error) { return nil, nil })
	if err != nil || got == nil || len(got) != 0 {
		t.Errorf("no values: %#v %v", got, err)
	}
	if got, _ := CallValues(ctx, v, func(string) ([]*int, error) { return []*int{&n, nil}, nil }); len(got) != 1 || got[0] != 3 {
		t.Errorf("values: %v", got)
	}
}
