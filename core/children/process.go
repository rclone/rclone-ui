package children

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rclone/rclone-ui/core/children/childenv"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/hostenv"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// drainWait is how long the parent keeps reading a child's pipes after the child has exited.
// The pipes can stay open when a grandchild that escaped the process group still holds them.
const drainWait = 2 * time.Second

// Process is one run of a unit's child process.
type Process struct {
	cmd       *exec.Cmd
	pid       int
	started   time.Time
	startTime int64
	// stdin is the core's end of the child's stdin. The child ends when it closes (see
	// childenv), so the child never outlives the app.
	stdin io.WriteCloser

	planned atomic.Bool // stopped on purpose, so its exit is not a failure
	killed  atomic.Bool // the stop ran out of time and killed it
	exited  chan struct{}
	err     error // returned by Wait; read it only after exited is closed
}

func (p *Process) PID() int { return p.pid }

func (p *Process) Started() time.Time { return p.started }

// Killed reports whether a stop had to kill the process, either because it didn't end within
// 10 s of SIGTERM or because it runs on Windows. A mount stopped that way still needs its
// cleanup (Unmount).
func (p *Process) Killed() bool { return p.killed.Load() }

// Err is the error from Wait, or nil for exit status 0. It is valid once the process has exited.
func (p *Process) Err() error { return p.err }

// exitError describes how the process ended, for a Down.
func (p *Process) exitError() error {
	if p.err == nil {
		// i18n: How the process of a mount or a serve ended, when it ended without an error.
		return TextError(i18n.M("exited with status 0"), nil)
	}
	return p.err
}

// spawn starts one run of the child. It runs on the unit's goroutine.
func (u *Unit) spawn() (*Process, error) {
	s := u.s
	// A killed child leaves its socket file behind, and rclone can't listen on a path that
	// already exists.
	if err := removeSocket(rcSock(s.o.SocketDir, u.id)); err != nil {
		return nil, err
	}
	argv := append([]string{s.o.Exe}, rcloneArgs(u.spec.Rclone, s.o.SocketDir, u.id, u.spec.ConfigPath, s.o.CacheDir, s.o.Limits())...)
	env := rcloneEnv(hostenv.Env(),
		"RCLONE_RC_USER="+u.rc.user,
		"RCLONE_RC_PASS="+u.rc.pass,
	)
	env = withLibraryPath(env, s.o.LibraryPath)
	// These come after the core's own variables. When a variable appears twice, the child gets
	// the last value, so a stray RCLONE_PASS in the core's environment doesn't replace a serve's
	// password.
	env = append(env, u.spec.SecretEnv...)
	if u.spec.Kind == KindMount && u.spec.MountPoint != "" {
		env = append(env, childenv.MountEnv+"="+u.spec.MountPoint)
	}
	var key string // the one-time key file, when the config is encrypted
	if u.spec.ConfigPassword != "" {
		var err error
		if key, err = rclone.ChildKeyFile(s.o.RunDir, u.spec.ConfigPassword); err != nil {
			return nil, fmt.Errorf("the key of %s's config: %w", u.spec.Name, err)
		}
		env = append(env, childenv.KeyFileEnv+"="+key)
	}
	// If the child fails before it reads its key file, the file is removed here.
	removeKey := func() {
		if key != "" {
			_ = os.Remove(key)
		}
	}

	outR, outW, err := os.Pipe()
	if err != nil {
		removeKey()
		return nil, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		_, _ = outR.Close(), outW.Close()
		removeKey()
		return nil, err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = env
	// These are files, not writers, so os/exec doesn't copy anything. Wait then returns when the
	// child exits, even if a grandchild keeps the pipes open.
	cmd.Stdout, cmd.Stderr = outW, errW
	cmd.SysProcAttr = sysProcAttr()
	// The core holds the child's stdin open (see childenv).
	stdin, err := childenv.Mark(cmd)
	if err != nil {
		_, _, _, _ = outR.Close(), outW.Close(), errR.Close(), errW.Close()
		removeKey()
		return nil, err
	}
	err = cmd.Start()
	_, _ = outW.Close(), errW.Close()
	if err != nil {
		_, _ = outR.Close(), errR.Close()
		removeKey()
		return nil, fmt.Errorf("start %s: %w", u.spec.Name, err)
	}
	pid := cmd.Process.Pid
	if err := s.os.afterStart(pid); err != nil {
		s.log.Warn("child started outside the children's job", "child", u.spec.Name, "pid", pid, "error", err)
	}
	startTime, err := processStartTime(pid)
	if err != nil {
		s.log.Warn("could not read a child's start time; a leftover of it would not be killed", "child", u.spec.Name, "pid", pid, "error", err)
	}
	p := &Process{cmd: cmd, pid: pid, started: time.Now(), startTime: startTime, stdin: stdin, exited: make(chan struct{})}
	u.mu.Lock()
	u.proc = p
	u.mu.Unlock()
	rec := u.record()
	rec.PID, rec.StartTime = pid, startTime
	s.started(rec)
	s.log.Info("child started", "child", u.spec.Name, "id", u.id, "pid", pid, "kind", u.spec.Kind)

	parse, emit := u.lines(p)
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		_ = logs.ReadChild(outR, logs.Stdout, parse, emit)
	}()
	go func() {
		defer readers.Done()
		_ = logs.ReadChild(errR, logs.Stderr, parse, emit)
	}()
	go func() {
		p.err = cmd.Wait()
		killGroup(pid) // whatever the child started and left behind
		if !syncx.Wait(context.Background(), &readers, drainWait) {
			s.log.Warn("a child's output stayed open after it exited; no longer reading it", "child", u.spec.Name, "pid", pid)
		}
		_, _ = outR.Close(), errR.Close()
		_ = stdin.Close()
		removeKey()
		// rclone never closes its rc server, so the socket file outlives the child. It is safe to
		// remove here, because the next spawn of this id only happens after exited.
		if err := removeSocket(rcSock(s.o.SocketDir, u.id)); err != nil {
			s.log.Warn("could not remove an exited child's rc socket", "child", u.spec.Name, "error", err)
		}
		s.exited(u.id)
		close(p.exited)
		select {
		case u.exits <- p:
		case <-u.done:
		}
	}()
	return p, nil
}

// lines returns the child's line parser and the function that receives its records. The
// child's rc password and secrets are masked out of the records.
func (u *Unit) lines(p *Process) (logs.LineParser, func(logs.Record)) {
	comp, sub := u.spec.Component, u.spec.Subcomponent
	if comp == "" {
		comp, sub = logs.CompChildren, u.spec.Name
	}
	parse := u.spec.Parse
	if parse == nil {
		parse = logs.RcloneChild(comp, sub)
	}
	// At debug level, the tunnel's cloudflared logs each request's headers. These include the
	// rc's basic auth, base64-encoded as it is in the header.
	secrets := append([]string{u.rc.pass, basicAuth(u.rc.user, u.rc.pass)}, u.spec.Secrets...)
	for _, kv := range u.spec.SecretEnv {
		_, v, _ := strings.Cut(kv, "=")
		secrets = append(secrets, v)
	}
	emit := masking(u.s.o.Emit, secrets...)
	if u.spec.QuietStop {
		next := emit
		emit = func(e logs.Record) {
			if p.planned.Load() && e.Level > slog.LevelInfo {
				e.Level = slog.LevelInfo
			}
			next(e)
		}
	}
	return parse, emit
}

// masking hides a rclone child's own secrets in its records. At DEBUG level, before its logging
// is set up, rclone prints every flag that it reads from the environment, with the value quoted
// (%q). For example: "Setting --rc-pass "…" from environment variable RCLONE_RC_PASS="…""
// (fs/config/flags/flags.go), and "Setting  pass="…" from environment variable RCLONE_PASS"
// (fs/configmap.go). The records are masked after parsing, once the JSON line is decoded, and
// this covers the text of a Go panic too.
func masking(emit func(logs.Record), secrets ...string) func(logs.Record) {
	m := logs.NewMask(secrets...)
	if m == nil {
		return emit
	}
	return func(e logs.Record) {
		m.Hide(&e)
		emit(e)
	}
}

// basicAuth returns the credentials as they appear in an Authorization: Basic header.
func basicAuth(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}

func removeSocket(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove the stale socket %s: %w", path, err)
	}
	return nil
}
