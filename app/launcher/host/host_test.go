package host

import (
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/launcher"
	"github.com/rclone/rclone-ui/app/launcher/state"
	"github.com/rclone/rclone-ui/app/launcher/view/viewtest"
	"github.com/rclone/rclone-ui/core"
)

func TestMainSyncRecovers(t *testing.T) {
	was := invokeSync
	t.Cleanup(func() { invokeSync = was })
	invokeSync = func(fn func()) {
		done := make(chan struct{})
		go func() {
			defer close(done)
			defer func() { _ = recover() }()
			fn()
		}()
		<-done
	}

	got := make(chan error, 1)
	go func() { got <- mainSync(func() { panic("the view broke") }) }()
	select {
	case err := <-got:
		if err == nil || !strings.Contains(err.Error(), "the view broke") {
			t.Fatalf("the error doesn't name the panic: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("mainSync waits forever after a panic")
	}

	ran := false
	if err := mainSync(func() { ran = true }); err != nil || !ran {
		t.Fatalf("a plain call: ran %v, error %v", ran, err)
	}
}

type tokenView struct {
	*viewtest.Fake
	tokens []string
}

func (v *tokenView) SetActivationToken(token string) { v.tokens = append(v.tokens, token) }

func TestPressKeepsATokenOnlyToShow(t *testing.T) {
	log := slog.New(slog.DiscardHandler)
	apis := core.NewAPIs(core.APIOptions{})
	src := state.New(corestate.New(corestate.APIReader(apis), log), coreAPIs{apis})
	l := launcher.New(launcher.Platform{Main: func(func()) {}, MainSync: func(fn func()) { fn() }}, log, src, nil)
	v := &tokenView{Fake: &viewtest.Fake{}}
	l.Attach(v)
	h := &Host{l: l, view: v, log: log}

	h.toggle("one")
	h.toggle("two")
	h.toggle("")
	if !v.Shown || !slices.Equal(v.tokens, []string{"one"}) {
		t.Fatalf("shown %v, tokens %q", v.Shown, v.tokens)
	}
	h.suspended.Add(1)
	h.toggle("three")
	if !v.Shown || len(v.tokens) != 1 {
		t.Fatalf("suspended: shown %v, tokens %q", v.Shown, v.tokens)
	}
	h.suspended.Add(-1)
	h.toggle("four")
	if v.Shown || len(v.tokens) != 1 {
		t.Fatalf("resumed: shown %v, tokens %q", v.Shown, v.tokens)
	}
}
