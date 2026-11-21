package runs

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"

	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/transfers"
)

// fakeTransfers records the starts and stops. Its transfers stay open until the test closes them.
type fakeTransfers struct {
	mu     sync.Mutex
	specs  []transfers.Spec
	stops  []string
	closed map[string]bool
	// refuse makes the next start fail without recording anything.
	refuse error
}

func (ft *fakeTransfers) Start(_ context.Context, spec transfers.Spec) (transfers.Started, error) {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	if err := ft.refuse; err != nil {
		ft.refuse = nil
		return transfers.Started{}, err
	}
	ft.specs = append(ft.specs, spec)
	return transfers.Started{ID: fmt.Sprintf("t%d", len(ft.specs)), Seq: int64(len(ft.specs))}, nil
}

func (ft *fakeTransfers) Stop(_ context.Context, id string) error {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	ft.stops = append(ft.stops, id)
	return nil
}

func (ft *fakeTransfers) Open(_ context.Context, id string) (bool, error) {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return !ft.closed[id], nil
}

// close closes start i (from 0) without reporting its end.
func (ft *fakeTransfers) close(i int) {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	if ft.closed == nil {
		ft.closed = map[string]bool{}
	}
	ft.closed[fmt.Sprintf("t%d", i+1)] = true
}

func (ft *fakeTransfers) count() int {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return len(ft.specs)
}

func (ft *fakeTransfers) stopped() []string {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return slices.Clone(ft.stops)
}

// end reports the end of start i (from 0), as the transfer service does once it is written.
func (ft *fakeTransfers) end(i int, state transfers.State) {
	ft.close(i)
	ft.mu.Lock()
	spec := ft.specs[i]
	ft.mu.Unlock()
	spec.Owner.Ended(transfers.Transfer{ID: fmt.Sprintf("t%d", i+1), State: state})
}

// fakeOwner starts its runs through a fakeTransfers and records what the engine tells it.
type fakeOwner struct {
	ft *fakeTransfers

	mu sync.Mutex
	// skip makes Start report that it didn't start the run.
	skip bool
	// afterStart, when set, runs in Start once the transfer service has answered.
	afterStart func(end transfers.Owner, started transfers.Started)
	// next and again are what Ended returns.
	next  string
	again bool
	// holdEnd, when set, makes Ended wait for it to be closed. inEnd is then closed when Ended
	// begins.
	holdEnd, inEnd chan struct{}

	modes   []string // the mode of each run that Start started
	started []string // the transfers that Started recorded
	refused []error
	ended   []transfers.Transfer
	changed int
}

func (o *fakeOwner) Start(ctx context.Context, id string, r *Run[string, int], end transfers.Owner) (transfers.Started, bool, error) {
	o.mu.Lock()
	skip, after := o.skip, o.afterStart
	o.mu.Unlock()
	if skip {
		return transfers.Started{}, false, nil
	}
	r.Data = len(id)
	started, err := o.ft.Start(ctx, transfers.Spec{Origin: transfers.Origin{Kind: transfers.OriginWatcher, ID: id}, Owner: end})
	if err == nil {
		o.mu.Lock()
		o.modes = append(o.modes, r.Mode)
		o.mu.Unlock()
	}
	if after != nil {
		after(end, started)
	}
	return started, true, err
}

func (o *fakeOwner) Started(_ context.Context, _ string, _ *Run[string, int], transfer string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.started = append(o.started, transfer)
}

func (o *fakeOwner) Refused(_ context.Context, _ string, _ *Run[string, int], err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.refused = append(o.refused, err)
}

func (o *fakeOwner) Quiet(*Run[string, int], transfers.State, string, *transfers.Summary) bool {
	return false
}

func (o *fakeOwner) Ended(_ context.Context, _ string, _ *Run[string, int], t transfers.Transfer) (string, bool) {
	o.mu.Lock()
	hold, in := o.holdEnd, o.inEnd
	o.mu.Unlock()
	if hold != nil {
		close(in)
		<-hold
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ended = append(o.ended, t)
	return o.next, o.again
}

func (o *fakeOwner) Changed() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.changed++
}

// fixture is an engine over a fakeOwner and a fakeTransfers. Its starts run on their own
// goroutines, which wait waits for.
type fixture struct {
	t     *testing.T
	e     *Engine[string, int]
	ft    *fakeTransfers
	owner *fakeOwner
	ctx   context.Context
	goes  sync.WaitGroup
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{t: t, ft: &fakeTransfers{}, ctx: context.Background()}
	f.owner = &fakeOwner{ft: f.ft}
	f.e = New(Options{
		Name: "test", Transfers: f.ft,
		Runner: syncx.RunnerFunc(func(_ string, fn func(context.Context)) { f.goes.Go(func() { fn(f.ctx) }) }),
	}, Owner[string, int](f.owner))
	t.Cleanup(f.goes.Wait)
	return f
}

// wait waits for the starts in progress.
func (f *fixture) wait() { f.goes.Wait() }

// current returns the run of the item id, and whether it has one.
func (f *fixture) current(id string) (Status[string], bool) {
	st, ok := f.e.Current()[id]
	return st, ok
}

func (f *fixture) modes() []string {
	f.owner.mu.Lock()
	defer f.owner.mu.Unlock()
	return slices.Clone(f.owner.modes)
}

// An item has one run at a time: while its run is in progress, Kick and Claim refuse another.
// Another item runs alongside it.
func TestNoOverlap(t *testing.T) {
	f := newFixture(t)
	if !f.e.Kick("a", "first") {
		t.Fatal("the first kick was refused")
	}
	f.wait()
	if f.e.Kick("a", "second") {
		t.Error("a second run was claimed")
	}
	if _, ok := f.e.Claim("a", "second"); ok {
		t.Error("a second run was claimed")
	}
	if st, ok := f.current("a"); !ok || st.Mode != "first" || st.Transfer != "t1" {
		t.Errorf("current %+v %v", st, ok)
	}
	if !f.e.Kick("b", "other") {
		t.Error("another item's run was refused")
	}
	f.wait()
	if f.ft.count() != 2 || !slices.Equal(f.owner.started, []string{"t1", "t2"}) {
		t.Errorf("%d starts, recorded %v", f.ft.count(), f.owner.started)
	}
	f.ft.end(0, transfers.StateCompleted)
	f.wait()
	if _, ok := f.current("a"); ok {
		t.Error("the run was kept after its end")
	}
	if f.owner.changed != 1 {
		t.Errorf("changed %d times, want 1", f.owner.changed)
	}
	if !f.e.Kick("a", "third") {
		t.Error("a run after the end was refused")
	}
}

// A run queued during another starts once that one ends, and a later Queue replaces it. With
// nothing queued, the run that the end asks for starts. A Queue with no run in progress starts
// at once.
func TestQueuedRunAfterAnEnd(t *testing.T) {
	f := newFixture(t)
	f.e.Queue("a", "first")
	f.wait()
	f.e.Queue("a", "resync")
	f.e.Queue("a", "force")
	if st, _ := f.current("a"); !st.Queued || st.Next != "force" {
		t.Errorf("current %+v", st)
	}
	f.owner.next, f.owner.again = "again", true
	f.ft.end(0, transfers.StateCompleted)
	f.wait()
	if got := f.modes(); !slices.Equal(got, []string{"first", "force"}) {
		t.Fatalf("ran %v, want the queued force", got)
	}
	f.ft.end(1, transfers.StateCompleted)
	f.wait()
	if got := f.modes(); !slices.Equal(got, []string{"first", "force", "again"}) {
		t.Fatalf("ran %v, want the run the end asked for", got)
	}
}

// A run that the owner didn't start, or that the transfer service refused, is freed, and so is the
// run that waited for it. A refusal that recorded nothing is the owner's to record. A start during
// a shutdown isn't.
func TestReleaseOnARefusalAndOnShutdown(t *testing.T) {
	f := newFixture(t)
	f.owner.skip = true
	f.e.Kick("a", "first")
	f.wait()
	if _, ok := f.current("a"); ok {
		t.Fatal("a run that didn't start was kept")
	}
	f.owner.skip = false

	refusal := errors.New(`couldn't find remote "gone"`)
	f.ft.refuse = refusal
	f.e.Kick("a", "refused")
	f.wait()
	if _, ok := f.current("a"); ok || !slices.Equal(f.owner.refused, []error{refusal}) || len(f.owner.started) != 0 {
		t.Fatalf("after a refusal: running %v, refused %v, started %v", ok, f.owner.refused, f.owner.started)
	}

	f.ft.refuse = transfers.ErrShuttingDown
	f.e.Kick("a", "late")
	f.wait()
	if _, ok := f.current("a"); ok || len(f.owner.refused) != 1 {
		t.Fatalf("after a start during a shutdown: running %v, refused %v", ok, f.owner.refused)
	}
	if f.owner.changed != 3 {
		t.Errorf("changed %d times, want 3", f.owner.changed)
	}
}

// After Shutdown, nothing claims or starts a run: not a kick, a queue, a claim, nor the run that
// an end asks for. A run already claimed is freed rather than started.
func TestNoKicksAfterShutdown(t *testing.T) {
	f := newFixture(t)
	f.e.Kick("a", "first")
	f.wait()
	claimed, _ := f.e.Claim("b", "claimed")
	f.e.Shutdown()
	f.e.Start(f.ctx, "b", claimed)
	if _, ok := f.current("b"); ok {
		t.Error("a claimed run was kept after the shutdown")
	}
	if f.e.Kick("c", "x") {
		t.Error("a kick after the shutdown")
	}
	if _, ok := f.e.Claim("c", "x"); ok {
		t.Error("a claim after the shutdown")
	}
	f.e.Queue("a", "queued")
	f.e.Queue("c", "queued")
	f.owner.next, f.owner.again = "again", true
	f.ft.end(0, transfers.StateInterrupted)
	f.wait()
	if got := f.modes(); !slices.Equal(got, []string{"first"}) || len(f.e.Current()) != 0 {
		t.Errorf("ran %v after the shutdown, current %v", got, f.e.Current())
	}
	if len(f.owner.ended) != 1 {
		t.Errorf("the end after the shutdown wasn't recorded: %v", f.owner.ended)
	}
}

// A run whose end is never reported is freed on the second tick that finds its transfer closed,
// and the run queued during it starts.
func TestStaleRunIsFreed(t *testing.T) {
	f := newFixture(t)
	f.e.Kick("a", "first")
	f.wait()
	f.e.Queue("a", "queued")
	f.e.FreeStale(f.ctx)
	if _, ok := f.current("a"); !ok {
		t.Fatal("an open run was freed")
	}
	f.ft.close(0)
	f.e.FreeStale(f.ctx)
	if st, ok := f.current("a"); !ok || st.Transfer != "t1" {
		t.Fatal("freed at the first tick")
	}
	f.e.FreeStale(f.ctx)
	f.wait()
	if got := f.modes(); !slices.Equal(got, []string{"first", "queued"}) {
		t.Fatalf("ran %v, want the queued run after the stale one", got)
	}
	if st, _ := f.current("a"); st.Transfer != "t2" || f.owner.changed != 1 {
		t.Errorf("current %+v, changed %d", st, f.owner.changed)
	}
}

// A run whose end is being recorded is never freed as stale, even when two ticks find its
// transfer closed: the next run would read the item as it was before that end.
func TestNeverFreedWhileTheEndIsRecorded(t *testing.T) {
	f := newFixture(t)
	f.e.Kick("a", "first")
	f.wait()
	f.ft.close(0)
	f.e.FreeStale(f.ctx) // the first tick that finds it closed
	hold, in := make(chan struct{}), make(chan struct{})
	f.owner.mu.Lock()
	f.owner.holdEnd, f.owner.inEnd = hold, in
	f.owner.mu.Unlock()
	ending := make(chan struct{})
	go func() {
		defer close(ending)
		f.ft.end(0, transfers.StateCompleted)
	}()
	<-in
	f.e.FreeStale(f.ctx)
	f.e.FreeStale(f.ctx)
	if _, ok := f.current("a"); !ok {
		t.Error("freed while its end was recorded")
	}
	if f.e.Kick("a", "second") {
		t.Error("a run started while the end was recorded")
	}
	close(hold)
	<-ending
	f.wait()
	if _, ok := f.current("a"); ok {
		t.Error("kept after its end")
	}
}

// A transfer that fails at once may report its end before its start returns. The run is then
// freed by that end, and Started isn't called: the end has already recorded that it ended.
func TestNoStartedAfterTheEnd(t *testing.T) {
	f := newFixture(t)
	f.owner.afterStart = func(end transfers.Owner, started transfers.Started) {
		end.Ended(transfers.Transfer{ID: started.ID, State: transfers.StateFailed, Error: "boom"})
	}
	f.e.Kick("a", "first")
	f.wait()
	if len(f.owner.started) != 0 || len(f.owner.ended) != 1 {
		t.Errorf("started %v, ended %v", f.owner.started, f.owner.ended)
	}
	if _, ok := f.current("a"); ok {
		t.Error("kept after its end")
	}
}

// A deleted item's run is stopped: at once when it has a transfer, or as soon as its start
// returns. Without stop, its run goes on, and its end still reaches the owner.
func TestADeletedItemsRunIsStopped(t *testing.T) {
	f := newFixture(t)
	f.e.Kick("a", "first")
	f.wait()
	f.e.Forget(f.ctx, "a", true)
	if got := f.ft.stopped(); !slices.Equal(got, []string{"t1"}) {
		t.Errorf("stopped %v, want t1", got)
	}
	if _, ok := f.current("a"); ok {
		t.Error("the deleted item's run was kept")
	}

	// Deleted while its start hasn't returned.
	starting, deleted := make(chan struct{}), make(chan struct{})
	f.owner.afterStart = func(transfers.Owner, transfers.Started) {
		close(starting)
		<-deleted
	}
	f.e.Kick("b", "first")
	<-starting
	f.e.Forget(f.ctx, "b", true)
	close(deleted)
	f.wait()
	if got := f.ft.stopped(); !slices.Equal(got, []string{"t1", "t2"}) {
		t.Errorf("stopped %v, want t1 and t2", got)
	}
	if !slices.Equal(f.owner.started, []string{"t1"}) {
		t.Errorf("recorded %v for a deleted item", f.owner.started)
	}
	f.owner.afterStart = nil

	// Without stop, the run goes on.
	f.e.Kick("c", "first")
	f.wait()
	f.e.Forget(f.ctx, "c", false)
	if got := f.ft.stopped(); len(got) != 2 {
		t.Errorf("stopped %v", got)
	}
	f.ft.end(2, transfers.StateCompleted)
	if len(f.owner.ended) != 1 || f.owner.ended[0].ID != "t3" {
		t.Errorf("ended %v", f.owner.ended)
	}
}
