package notifications

import (
	"context"
	"crypto/x509"
	"fmt"
	"hash/fnv"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/version"
)

const (
	queueSize  = 256
	laneCount  = 4
	laneSize   = 64
	retryAfter = 2 * time.Second
)

type Secrets interface {
	Get(account string) (string, error)
	Set(account, secret string) error
	Delete(account string) error
}

type Service struct {
	db      *db.DB
	secrets Secrets
	bus     *bus.Bus
	client  *http.Client
	run     syncx.Runner
	log     *slog.Logger

	queue chan notified
	lanes [laneCount]chan delivery

	desktopMu sync.Mutex
	heard     bool
	held      []bus.NotifyOSData

	version    string
	now        func() time.Time
	retryDelay time.Duration
	tlsRoots   *x509.CertPool
}

type notified struct {
	ctx context.Context
	msg message
}

type delivery struct {
	notified
	target NotificationTarget
	smtp   *smtpSettings
}

type smtpSettings struct {
	cfg *SMTP
	err error
}

func New(d *db.DB, secrets Secrets, b *bus.Bus, client *http.Client, run syncx.Runner) *Service {
	svc := &Service{
		db: d, secrets: secrets, bus: b, client: client, run: run,
		log:        logs.Logger(logs.CompNotifications, ""),
		queue:      make(chan notified, queueSize),
		version:    strings.TrimPrefix(version.App, "v"),
		now:        time.Now,
		retryDelay: retryAfter,
	}
	for i := range svc.lanes {
		svc.lanes[i] = make(chan delivery, laneSize)
	}
	return svc
}

func (s *Service) Start() {
	s.run.Go("notifications", s.route)
	for _, lane := range s.lanes {
		s.run.Go("notifications-send", func(ctx context.Context) { s.send(ctx, lane) })
	}
	if s.bus != nil {
		s.run.GoOnce("notifications.desktop-held", s.showHeld)
	}
}

// Notify queues event for every enabled target subscribed to it, and sends it later. It never
// blocks. When too many notifications are already waiting, it drops this one and logs it.
func (s *Service) Notify(ctx context.Context, event NotificationEvent, p Payload) {
	meta, ok := lookup(event)
	if !ok {
		s.log.ErrorContext(ctx, "not a notification event", "event", string(event))
		return
	}
	title, body := meta.Label, ""
	if p != nil {
		p = redacted(p)
		title, body = p.Message(event)
	}
	n := notified{ctx: context.WithoutCancel(ctx), msg: message{meta: meta, title: title, body: body, data: p, at: s.now()}}
	select {
	case s.queue <- n:
	default:
		s.log.WarnContext(ctx, "notification dropped: too many are waiting", "event", string(event))
	}
}

func (s *Service) route(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case n := <-s.queue:
			s.fanOut(ctx, n)
		}
	}
}

func (s *Service) fanOut(ctx context.Context, n notified) {
	targets, broken, err := s.subscribed(ctx, n.msg.meta.ID)
	if err != nil {
		s.log.ErrorContext(n.ctx, "reading the notification targets failed", "event", string(n.msg.meta.ID), "error", err)
		return
	}
	for id, err := range broken {
		s.log.ErrorContext(n.ctx, "a notification target cannot be read", "target", id, "error", err)
		s.record(ctx, id, err)
	}
	var server *smtpSettings
	for _, t := range targets {
		d := delivery{notified: n, target: t}
		if t.Provider == NotificationProviderEmail {
			if server == nil {
				cfg, err := s.savedSMTP(ctx)
				server = &smtpSettings{cfg, err}
			}
			d.smtp = server
		}
		select {
		case s.lanes[laneOf(t.ID)] <- d:
		default:
			s.logFor(t.Provider).WarnContext(n.ctx, "notification dropped: too many are waiting for this target",
				"event", string(n.msg.meta.ID), "target", t.Name)
		}
	}
}

func laneOf(id string) int {
	h := fnv.New32a()
	h.Write([]byte(id))
	return int(h.Sum32() % laneCount)
}

func (s *Service) send(ctx context.Context, lane <-chan delivery) {
	for {
		select {
		case <-ctx.Done():
			return
		case d := <-lane:
			s.deliver(ctx, d)
		}
	}
}

func (s *Service) deliver(ctx context.Context, d delivery) {
	sendCtx, cancel := context.WithCancel(d.ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	var err error
	if d.smtp != nil {
		err = d.smtp.err
	}
	if err == nil {
		err = s.sendTo(sendCtx, d.target, d.msg, d.smtp)
	}
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		s.logFor(d.target.Provider).WarnContext(d.ctx, "delivery failed", "event", string(d.msg.meta.ID),
			"target", d.target.Name, "error", err)
	}
	s.record(ctx, d.target.ID, err)
}

func (s *Service) sendTo(ctx context.Context, t NotificationTarget, m message, smtp *smtpSettings) error {
	if t.Provider == NotificationProviderEmail {
		if smtp != nil && smtp.err != nil {
			return fmt.Errorf("reading the mail server: %w", smtp.err)
		}
		if smtp == nil || smtp.cfg == nil {
			return errNotSetUp
		}
		return s.mail(ctx, *smtp.cfg, recipients(t.URL), m.title, m.body)
	}
	r, err := buildRequest(t.Provider, t.URL, m, s.version)
	if err != nil {
		return err
	}
	return s.post(ctx, r)
}

func (s *Service) logFor(p NotificationProvider) *slog.Logger {
	return logs.Logger(logs.CompNotifications, string(p))
}

// Test sends the test notification, either to a saved target or to the unsaved form (see
// TestInput). For a saved target, the outcome is recorded on it like any delivery. A failed
// delivery is returned in the Outcome, not as an error. A webhook test can take up to two
// 15-second attempts plus the wait between them.
func (s *Service) Test(ctx context.Context, in TestInput) (Outcome, error) {
	t := NotificationTarget{Provider: in.Provider, Name: in.Name, URL: strings.TrimSpace(in.URL)}
	if in.ID != "" {
		var err error
		if t, err = s.target(ctx, in.ID); err != nil {
			return Outcome{}, err
		}
	} else {
		if !knownProvider(t.Provider) {
			return Outcome{}, errs.Field("provider", "No such provider.")
		}
		if err := validateURL(t.Provider, t.URL); err != nil {
			return Outcome{}, err
		}
	}
	title, body := testMessage(t.Name)
	m := message{meta: testEvent.meta(), title: title, body: body, at: s.now()}
	var server *smtpSettings
	if t.Provider == NotificationProviderEmail {
		cfg, err := s.savedSMTP(ctx)
		if err != nil {
			return Outcome{}, err
		}
		server = &smtpSettings{cfg: cfg}
	}
	err := s.sendTo(ctx, t, m, server)
	if in.ID != "" && (err == nil || ctx.Err() == nil) {
		s.record(context.WithoutCancel(ctx), in.ID, err)
	}
	return outcome(err, i18n.T("Test notification sent successfully.")), nil
}

func outcome(err error, success string) Outcome {
	if err != nil {
		return Outcome{Message: i18n.Localize(err)}
	}
	return Outcome{OK: true, Message: success}
}

func firstProblem(problems map[string]error, order ...string) error {
	for _, f := range order {
		if err, ok := problems[f]; ok {
			return err
		}
	}
	return nil
}
