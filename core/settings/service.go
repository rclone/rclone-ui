// Package settings stores the app's settings document (types.go). The core applies the proxy to
// rclone, and the language to everything the Go side says (core/i18n). The ui applies the rest:
// the launcher shortcut, the tray icon, the startup window and the update channel. Pages change
// the settings through the API. The ui reads them through the same API and reloads them on each
// settings.changed event.
package settings

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"runtime"
	"slices"
	"strings"
	"sync"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/version"
)

// invalid puts the field's path before the message of refusal (an errs.Field error), because the
// Settings page shows the message as is. The field's own description stays without the path.
func invalid(refusal error) error {
	// i18n: A setting's path, such as proxy.url, then why its value is refused.
	return errs.Errorf("%s: %w", errs.FieldOf(refusal), refusal)
}

type Service struct {
	db  *db.DB
	bus *bus.Bus

	mu        sync.Mutex
	onBwLimit []func(ctx context.Context, limit string)
	onChange  []func(Settings)
}

func (s *Service) OnChange(fn func(Settings)) {
	s.mu.Lock()
	s.onChange = append(s.onChange, fn)
	s.mu.Unlock()
}

// OnBwLimit adds fn to the functions called after the bandwidth limit changes, with the new
// limit, which BwLimit accepts.
func (s *Service) OnBwLimit(fn func(ctx context.Context, limit string)) {
	s.mu.Lock()
	s.onBwLimit = append(s.onBwLimit, fn)
	s.mu.Unlock()
}

func New(d *db.DB, b *bus.Bus) *Service { return &Service{db: d, bus: b} }

// defaultChannel is the update channel of a build with the given version. A pre-release such as
// 4.0.0-beta.1 follows the betas, so that it is offered the next beta.
func defaultChannel(v string) string {
	if strings.Contains(v, "-") {
		return "beta"
	}
	return "stable"
}

// Defaults returns the settings used before anything is saved.
func Defaults() Settings {
	return Settings{
		Appearance: Appearance{TrayIcon: TrayIconDefault},
		Proxy:      Proxy{IgnoredHosts: []string{}},
		Updates:    Updates{Channel: defaultChannel(version.App)},
		Agents:     Agents{Port: DefaultAgentPort},
		Telemetry:  Telemetry{Enabled: TelemetryDefault(runtime.GOOS)},
	}
}

// TelemetryDefault reports whether usage data and crash reports are shared on the OS goos until
// the user chooses. They are on macOS and Windows, where the user can turn them off. On Linux
// they are off, and the user turns them on.
func TelemetryDefault(goos string) bool { return goos != "linux" }

// newToken returns a random token for the agents' server: 32 bytes, in URL-safe base64.
func newToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand doesn't fail on the systems the app runs on
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Get returns the settings: the saved document applied over the defaults.
func (s *Service) Get(ctx context.Context) (Settings, error) {
	var out Settings
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		var err error
		out, err = load(ctx, tx)
		return err
	})
	return out, err
}

// load reads the settings in tx, as Get returns them: the saved document over the defaults, so a
// field that it lacks keeps its default. A document that can't be read fails, because falling
// back to the defaults would let the next Update overwrite it.
func load(ctx context.Context, tx *sql.Tx) (Settings, error) {
	var doc string
	err := tx.QueryRowContext(ctx, `SELECT doc FROM settings WHERE id = 1`).Scan(&doc)
	out := Defaults()
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return out, nil
	case err != nil:
		return Settings{}, err
	}
	if err := json.Unmarshal([]byte(doc), &out); err != nil {
		return Settings{}, fmt.Errorf("the saved settings: %w", err)
	}
	if out.Proxy.IgnoredHosts == nil {
		out.Proxy.IgnoredHosts = []string{}
	}
	return out, nil
}

// Update applies p to the settings, saves them, and returns the new settings. restart is true
// when part of the change only applies after the app starts again. That is the proxy, which
// rclone reads when it starts.
func (s *Service) Update(ctx context.Context, p Patch) (out Settings, restart bool, err error) {
	// Read and write in one write transaction. When two updates run at once, the second one
	// reads what the first wrote, so neither loses the other's change.
	var cur, next Settings
	if err := s.db.Write(ctx, func(tx *sql.Tx) error {
		var err error
		if cur, err = load(ctx, tx); err != nil {
			return err
		}
		next = cur
		next.Proxy.IgnoredHosts = slices.Clone(cur.Proxy.IgnoredHosts)
		p.apply(&next)
		next.Transfers.BwLimit = strings.TrimSpace(next.Transfers.BwLimit)
		if err := validate(next); err != nil {
			return err
		}
		doc, err := json.Marshal(next)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO settings (id, doc, updated_at) VALUES (1, ?, ?)
			ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
			string(doc), db.NowMS())
		return err
	}); err != nil {
		return Settings{}, false, err
	}
	if cur.General.Language != next.General.Language {
		// Before the event, so that whoever handles it already speaks the new language.
		i18n.SetLanguage(next.General.Language)
	}
	restart = cur.Proxy.URL != next.Proxy.URL || !slices.Equal(cur.Proxy.IgnoredHosts, next.Proxy.IgnoredHosts)
	if cur.Transfers.BwLimit != next.Transfers.BwLimit {
		s.mu.Lock()
		fns := slices.Clone(s.onBwLimit)
		s.mu.Unlock()
		for _, fn := range fns {
			fn(ctx, next.Transfers.BwLimit)
		}
	}
	s.mu.Lock()
	changed := slices.Clone(s.onChange)
	s.mu.Unlock()
	for _, fn := range changed {
		fn(next)
	}
	s.bus.Publish(bus.SettingsChanged, nil)
	return next, restart, nil
}

func validate(st Settings) error {
	switch st.Appearance.TrayIcon {
	case TrayIconDefault, TrayIconSystem, TrayIconColor, TrayIconDark, TrayIconLight:
	default:
		return invalid(errs.Field("appearance.tray_icon", "%q is not a tray icon", st.Appearance.TrayIcon))
	}
	if p := st.Proxy; p.URL != "" {
		u, err := url.Parse(p.URL)
		if err != nil || u.Host == "" || !slices.Contains([]string{"http", "https", "socks5", "socks5h"}, u.Scheme) {
			return invalid(errs.Field("proxy.url", badProxyURL))
		}
		for _, h := range p.IgnoredHosts {
			if strings.TrimSpace(h) == "" || strings.ContainsAny(h, " \t/") {
				return invalid(errs.Field("proxy.ignored_hosts", "%q is not a host", h))
			}
		}
	}
	if _, err := BwLimit(st.Transfers.BwLimit); err != nil {
		return err
	}
	if !i18n.Valid(st.General.Language) {
		return invalid(errs.Field("general.language", "%q is not one of the app's languages", st.General.Language))
	}
	if p := st.Agents.Port; p < 1024 || p > 65535 {
		return invalid(errs.Field("agents.port", "The port is a number from 1024 to 65535."))
	}
	if ch := st.Updates.Channel; ch != "stable" && ch != "beta" {
		return invalid(errs.Field("updates.channel", `must be "stable" or "beta"`))
	}
	return nil
}
