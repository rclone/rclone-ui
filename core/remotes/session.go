package remotes

import (
	"context"
	"errors"
	"maps"
	"net"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/obscure"
	"github.com/rclone/rclone/fs/rc"
	"github.com/rclone/rclone/fs/rc/jobs"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/rclone"
)

// rclone's config.CreateRemote and UpdateRemote block until an OAuth token arrives, and they use
// one fixed listener (127.0.0.1:53682).
const (
	sessionIdle  = 15 * time.Minute
	sessionPoll  = 500 * time.Millisecond
	finishedKept = 5 * time.Minute
	endWait      = 10 * time.Second
	strayWait    = 500 * time.Millisecond // wait after stopping a stray login, while its listener closes
)

var interactiveTypes = []string{"jottacloud", "onedrive", "zoho", "seafile", "sugarsync", "iclouddrive", "internxt"}

var errNotWaiting = errs.Precondition("The session is not waiting for an answer.")

// ErrNoSession is returned for a session that isn't the current one.
var ErrNoSession = errs.NotFound("session", "that remote session is over")

type Sessions struct {
	s    *Service
	idle time.Duration
	poll time.Duration

	startMu sync.Mutex

	mu       sync.Mutex
	cur      *session
	watching bool
}

type session struct {
	step        Step
	typ         string
	newName     string
	interactive bool
	values      map[string]any
	job         *jobs.Job
	rcState     string
	notice      string
	wrote       bool
	completing  bool
	active      time.Time
	ended       time.Time
}

func (x *session) finished() bool {
	switch x.step.State {
	case StateDone, StateFailed, StateCancelled:
		return true
	}
	return false
}

func newSessions(s *Service) *Sessions {
	return &Sessions{
		s: s, idle: sessionIdle, poll: sessionPoll,
	}
}

// Current returns the running session, if there is one. A finished session stays for
// finishedKept, or until it is cancelled.
func (ss *Sessions) Current(ctx context.Context) *Step {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	x := ss.cur
	if x == nil {
		return nil
	}
	if x.finished() && ss.s.now().Sub(x.ended) >= finishedKept {
		ss.cur = nil
		return nil
	}
	step := x.step
	return &step
}

func (ss *Sessions) creating() string {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if x := ss.cur; x != nil && x.step.Kind == KindCreate && !x.finished() {
		return x.step.Remote
	}
	return ""
}

// Start begins a session, replacing the running one. Problems with the request are returned as
// errs.Field errors.
func (ss *Sessions) Start(ctx context.Context, req StartRequest) (Step, error) {
	ss.startMu.Lock()
	defer ss.startMu.Unlock()
	ss.mu.Lock()
	prev := ss.cur
	ss.mu.Unlock()
	if prev != nil {
		if cleanup, ok := ss.finish(prev, StateCancelled, nil); ok {
			cleanup()
		}
	}

	x, err := ss.prepare(ctx, req)
	if err != nil {
		return Step{}, err
	}

	ss.stopStray()
	ss.mu.Lock()
	ss.cur = x
	x.active = ss.s.now()
	step := x.step
	ss.mu.Unlock()
	ss.publish(x)
	ss.begin(x)
	ss.watch()
	return step, nil
}

func (ss *Sessions) prepare(ctx context.Context, req StartRequest) (*session, error) {
	x := &session{
		step:   Step{ID: ids.New(), Remote: req.Name, Kind: req.Kind, State: StateWorking},
		values: req.Values,
	}
	switch req.Kind {
	case KindCreate:
		if err := rclone.CheckNewRemoteName("name", req.Name, ss.s.st.GetSectionList()); err != nil {
			return nil, err
		}
		if req.Type == "" {
			return nil, errs.Field("type", "Choose the remote's type.")
		}
		if _, err := fs.Find(req.Type); err != nil {
			return nil, errs.Field("type", "Rclone has no backend called %s.", req.Type)
		}
		x.typ = req.Type
	case KindUpdate, KindReconnect:
		cur := ss.s.section(req.Name)
		if cur["type"] == "" {
			return nil, ErrNotFound
		}
		x.typ = cur["type"]
		if req.Kind == KindReconnect {
			x.values = nil
			break
		}
		if req.NewName != "" && req.NewName != req.Name {
			if err := rclone.CheckNewRemoteName("newName", req.NewName, ss.s.st.GetSectionList()); err != nil {
				return nil, err
			}
			x.newName = req.NewName
		}
	default:
		return nil, errs.Field("kind", "A session creates, updates or reconnects a remote.")
	}
	x.step.Type = x.typ
	x.interactive = req.NonInteractive || slices.Contains(interactiveTypes, x.typ)
	return x, nil
}

func (ss *Sessions) begin(x *session) {
	name := x.step.Remote
	opt := config.UpdateRemoteOpt{Obscure: true, NonInteractive: x.interactive}
	switch x.step.Kind {
	case KindCreate:
		params := withLogin(x.values)
		ss.run(x, func(ctx context.Context) (*fs.ConfigOut, error) {
			return config.CreateRemote(ctx, name, x.typ, params, opt)
		})
	case KindUpdate:
		if len(x.values) == 0 {
			ss.succeed(x)
			return
		}
		params := withLogin(x.values)
		if !x.interactive {
			// An edit keeps the existing sign-in. Otherwise rclone would answer its own "Token
			// already configured - replace it?" with yes and wait for a new login.
			params["config_refresh_token"] = "false"
		}
		ss.run(x, func(ctx context.Context) (*fs.ConfigOut, error) {
			return config.UpdateRemote(ctx, name, params, opt)
		})
	case KindReconnect:
		// The providers that are configured one question at a time ask their questions, because
		// rclone stores no config_* answers (OneDrive's drive, Jottacloud's device), and answering
		// with the defaults would point the remote somewhere else. Other backends' questions are
		// answered with their defaults, which include the saved values.
		opt := config.UpdateRemoteOpt{}
		if x.interactive {
			opt.NonInteractive = true
		}
		params := loginParams(x)
		ss.run(x, func(ctx context.Context) (*fs.ConfigOut, error) {
			return config.UpdateRemote(ctx, name, params, opt)
		})
	}
}

func (ss *Sessions) cont(x *session, state, result string) {
	name, typ := x.step.Remote, x.typ
	opt := config.UpdateRemoteOpt{NonInteractive: true, Continue: true, State: state, Result: result}
	params := loginParams(x)
	if x.step.Kind == KindCreate {
		ss.run(x, func(ctx context.Context) (*fs.ConfigOut, error) {
			return config.CreateRemote(ctx, name, typ, params, opt)
		})
		return
	}
	ss.run(x, func(ctx context.Context) (*fs.ConfigOut, error) {
		return config.UpdateRemote(ctx, name, params, opt)
	})
}

func withLogin(values map[string]any) rc.Params {
	out := rc.Params{}
	maps.Copy(out, values)
	out["config_auth_no_browser"] = "true"
	return out
}

func loginParams(x *session) rc.Params {
	params := withLogin(nil)
	if x.step.Kind == KindReconnect {
		params["config_refresh_token"] = "true"
	}
	return params
}

type configCall func(ctx context.Context) (*fs.ConfigOut, error)

type callResult struct {
	out *fs.ConfigOut
	err error
}

func (ss *Sessions) run(x *session, call configCall) {
	res := &callResult{}
	opts := rclone.CallOpts{Async: true, Group: rclone.UIGroup("config", x.step.ID)}
	job, err := rclone.Run(context.Background(), opts, func(ctx context.Context) error {
		res.out, res.err = call(ctx)
		return res.err
	})
	if err != nil {
		ss.fail(x, err)
		return
	}
	ss.mu.Lock()
	if ss.cur != x || x.finished() {
		ss.mu.Unlock()
		ss.stopCall(job, x.step.Remote)
		if x.step.Kind == KindCreate {
			ss.removeUnfinished(x.step.Remote)
		}
		return
	}
	x.job, x.wrote = job, true
	ss.mu.Unlock()
	// The listener runs after the job ends, so it sees res as the call left it.
	job.OnFinish(func() { ss.jobDone(x, job, res) })
}

func (ss *Sessions) jobDone(x *session, job *jobs.Job, res *callResult) {
	defer func() {
		if r := recover(); r != nil {
			ss.s.log.Error("remotes: config session step panicked", "panic", r)
			ss.fail(x, errs.Errorf("internal error: %v", r))
		}
	}()
	out := res.out
	if out == nil {
		out = &fs.ConfigOut{}
	}
	asks := out.Option != nil
	// An error with no state to go on from is rclone's last word: the setup can't be finished as
	// it was asked ("Password can't be blank", "No Shared Drives found in your account").
	// rclone's own command line prints it and stops.
	refused := job.Success && out.State == "" && out.Error != ""
	// Otherwise, no state to go on from means done. So does a state with neither a question
	// nor an error, because rclone follows such states itself.
	done := job.Success && !refused && (out.State == "" || !asks && out.Error == "")
	ss.mu.Lock()
	if ss.cur != x || x.job != job || x.finished() {
		ss.mu.Unlock()
		return
	}
	x.job = nil
	x.completing = done
	ss.mu.Unlock()
	rclone.DeleteGroup(context.Background(), job.Group)
	switch {
	case !job.Success:
		// Use job.Error rather than res.err, because a fatal rclone error shows up as the job's
		// recovered panic.
		if cleanup, ok := ss.finishBusy(x, errors.New(job.Error), listenerBusy(res.err)); ok {
			cleanup()
		}
	case refused:
		ss.fail(x, setupError(out.Error))
	case done:
		ss.succeed(x)
	case asks:
		ss.mu.Lock()
		if ss.cur != x || x.finished() {
			ss.mu.Unlock()
			return
		}
		x.step.State, x.step.Question, x.step.Notice = StateQuestion, out.Option, x.notice
		x.step.AuthURL = ""
		x.notice, x.rcState, x.active = "", out.State, ss.s.now()
		ss.mu.Unlock()
		ss.publish(x)
	case out.Error != "":
		// A soft error is shown with the question that rclone asks again from the state it
		// points to.
		ss.mu.Lock()
		x.notice = out.Error
		ss.mu.Unlock()
		ss.cont(x, out.State, out.Result)
	}
}

type setupError string

func (e setupError) Error() string { return string(e) }

const unknownPort = "the sign-in port"

func listenerBusy(err error) string {
	var op *net.OpError
	if !errors.As(err, &op) || op.Op != "listen" || !errors.Is(op.Err, errAddrInUse) {
		return ""
	}
	if op.Addr != nil {
		return op.Addr.String()
	}
	return unknownPort
}

func (ss *Sessions) succeed(x *session) {
	name := x.step.Remote
	res := &StepResult{Name: name}
	if x.wrote {
		if err := ss.s.saveError(); err != nil {
			ss.s.Changed([]string{name})
			ss.fail(x, errs.Errorf("The remote could not be saved: %w", err))
			return
		}
	}
	if x.newName != "" {
		r, err := ss.s.rename(context.Background(), name, x.newName)
		if err != nil {
			if x.wrote {
				ss.s.Changed([]string{name})
				err = errs.Errorf("The changes were saved, but the rename failed: %w", err)
			}
			ss.mu.Lock()
			if !x.finished() {
				x.step.Field = "newName"
			}
			ss.mu.Unlock()
			ss.fail(x, err)
			return
		}
		res = r
	} else if x.wrote {
		ss.s.Changed([]string{name})
	}
	ss.mu.Lock()
	if x.finished() {
		ss.mu.Unlock()
		return
	}
	x.step.State, x.step.Result = StateDone, res
	x.step.AuthURL, x.step.Question = "", nil
	x.ended = ss.s.now()
	ss.mu.Unlock()
	ss.publish(x)
}

func (ss *Sessions) fail(x *session, err error) {
	if cleanup, ok := ss.finish(x, StateFailed, err); ok {
		cleanup()
	}
}

func (ss *Sessions) finishBusy(x *session, err error, busy string) (func(), bool) {
	ss.mu.Lock()
	if !x.finished() {
		x.step.Busy = busy
	}
	ss.mu.Unlock()
	return ss.finish(x, StateFailed, err)
}

func (ss *Sessions) finish(x *session, state string, err error) (func(), bool) {
	return ss.end(x, state, err, state == StateCancelled)
}

func (ss *Sessions) end(x *session, state string, err error, spareCompleting bool) (func(), bool) {
	ss.mu.Lock()
	if x.finished() || x.completing && spareCompleting {
		ss.mu.Unlock()
		return nil, false
	}
	x.step.State, x.step.Error = state, err
	x.step.AuthURL, x.step.Question = "", nil
	x.ended = ss.s.now()
	job, kind, name := x.job, x.step.Kind, x.step.Remote
	x.job = nil
	ss.mu.Unlock()
	ss.publish(x)
	return func() {
		if job != nil {
			ss.stopCall(job, name)
		}
		ss.stopOAuth()
		if kind == KindCreate {
			ss.removeUnfinished(name)
		}
	}, true
}

func (ss *Sessions) stopCall(job *jobs.Job, name string) {
	done := make(chan struct{})
	stopListening := job.OnFinish(func() { close(done) })
	job.Stop()
	select {
	case <-done:
	case <-time.After(endWait):
		stopListening()
		ss.s.log.Warn("remotes: a stopped config session's rclone call has not ended", "remote", name)
	}
	rclone.DeleteGroup(context.Background(), job.Group)
}

func (ss *Sessions) removeUnfinished(name string) {
	if err := ss.s.deleteSection(name); err != nil {
		ss.s.log.Error("remotes: removing an unfinished remote", "remote", name, "error", err)
	}
	ss.s.Changed([]string{name})
}

func (ss *Sessions) owned(_ context.Context, id string) (*session, error) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	x := ss.cur
	if x == nil || x.step.ID != id {
		return nil, ErrNoSession
	}
	return x, nil
}

func (ss *Sessions) Answer(ctx context.Context, id, value string) error {
	x, err := ss.owned(ctx, id)
	if err != nil {
		return err
	}
	ss.mu.Lock()
	if x.step.State != StateQuestion {
		ss.mu.Unlock()
		return errNotWaiting
	}
	ss.mu.Unlock()
	ss.mu.Lock()
	if x.step.State != StateQuestion || ss.cur != x {
		ss.mu.Unlock()
		return errNotWaiting
	}
	state := x.rcState
	value, err = answer(x.typ, x.step.Question, value)
	if err != nil {
		ss.mu.Unlock()
		return err
	}
	x.step.State, x.step.Question, x.step.Notice = StateWorking, nil, ""
	x.active = ss.s.now()
	ss.mu.Unlock()
	ss.publish(x)
	ss.cont(x, state, value)
	return nil
}

// A password is obscured, as rclone's own config passes it on, because some backends reveal it
// (SugarSync, Jottacloud's legacy login). Seafile's two-factor login takes its password as plain
// text and obscures it itself.
func answer(typ string, q *fs.Option, value string) (string, error) {
	if q == nil || !q.IsPassword || value == "" || typ == "seafile" && q.Name == "config_password" {
		return value, nil
	}
	return obscure.Obscure(value)
}

// Cancel ends the session, or forgets it if it has already finished. The cleanup runs in the
// background.
func (ss *Sessions) Cancel(ctx context.Context, id string) error {
	x, err := ss.owned(ctx, id)
	if err != nil {
		return err
	}
	cleanup, ok := ss.finish(x, StateCancelled, nil)
	if ok {
		ss.s.run.GoOnce("remotes-session-end", func(context.Context) { cleanup() })
		return nil
	}
	ss.mu.Lock()
	if ss.cur == x && x.finished() {
		ss.cur = nil
	}
	ss.mu.Unlock()
	return nil
}

// oauthStatus returns the state of rclone's login as config/oauthstatus reports it.
// lib/oauthutil keeps that state unexported, so this and config/oauthstop remain rc calls.
func oauthStatus() (running bool, authURL string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, _, err := rclone.Call(ctx, "config/oauthstatus", rc.Params{}, rclone.CallOpts{})
	if err != nil {
		return false, ""
	}
	status, _ := out.GetString("status")
	authURL, _ = out.GetString("authUrl")
	return status == "running", authURL
}

func (ss *Sessions) stopOAuth() bool {
	if running, _ := oauthStatus(); !running {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The login may have ended in the meantime. rclone reports that only as text, with no
	// error value to match.
	if _, _, err := rclone.Call(ctx, "config/oauthstop", rc.Params{}, rclone.CallOpts{}); err != nil &&
		!strings.Contains(err.Error(), "no oauth authentication is in progress") {
		ss.s.log.Warn("remotes: stopping rclone's login", "error", err)
	}
	return true
}

func (ss *Sessions) stopStray() {
	if ss.stopOAuth() {
		time.Sleep(strayWait)
	}
}

func (ss *Sessions) publish(x *session) {
	ss.mu.Lock()
	data := bus.RemotesSessionData{ID: x.step.ID, State: x.step.State}
	ss.mu.Unlock()
	ss.s.bus.Publish(bus.RemotesSession, data)
}

func (ss *Sessions) watch() {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.watching {
		return
	}
	ss.watching = true
	ss.s.run.Go("remotes-session", ss.watchLoop)
}

func (ss *Sessions) watchLoop(ctx context.Context) {
	t := time.NewTicker(ss.poll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			ss.mu.Lock()
			ss.watching = false
			ss.mu.Unlock()
			return
		case <-t.C:
		}
		if !ss.tick() {
			return
		}
	}
}

func (ss *Sessions) tick() bool {
	ss.mu.Lock()
	x := ss.cur
	if x == nil || x.finished() {
		ss.watching = false
		ss.mu.Unlock()
		return false
	}
	idle := ss.s.now().Sub(x.active) >= ss.idle && !x.completing
	running := x.job != nil
	ss.mu.Unlock()
	if idle {
		if cleanup, ok := ss.finish(x, StateFailed, errs.New("Nothing happened for too long, so the session was stopped.")); ok {
			cleanup()
		}
		return true
	}
	if !running {
		return true
	}
	waiting, authURL := oauthStatus()
	changed := false
	ss.mu.Lock()
	if ss.cur == x && x.job != nil && !x.finished() {
		switch {
		case waiting && authURL != "" && (x.step.State != StateAuthorize || x.step.AuthURL != authURL):
			x.step.State, x.step.AuthURL = StateAuthorize, authURL
			x.active, changed = ss.s.now(), true
		case !waiting && x.step.State == StateAuthorize:
			x.step.State, x.step.AuthURL = StateWorking, ""
			x.active, changed = ss.s.now(), true
		}
	}
	ss.mu.Unlock()
	if changed {
		ss.publish(x)
	}
	return true
}
