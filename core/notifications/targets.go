package notifications

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

var ErrTargetNotFound = errs.NotFound("target", "Notification target not found.")

// urlKey returns a key for url that ignores case, used to keep target urls unique.
func urlKey(url string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(url)))
	return hex.EncodeToString(sum[:])
}

const targetCols = `id, name, provider, url, events, enabled, last_sent_ms, last_error, created_ms`

func (s *Service) scanTarget(row db.Scanner) (NotificationTarget, error) {
	var t NotificationTarget
	var evs string
	var lastSent sql.NullInt64
	var lastErr sql.NullString
	if err := row.Scan(&t.ID, &t.Name, &t.Provider, &t.URL, &evs, &t.IsEnabled, &lastSent, &lastErr, &t.CreatedAt); err != nil {
		return t, err
	}
	if lastSent.Valid {
		t.LastSentAt = &lastSent.Int64
	}
	t.lastError = i18n.Saved(lastErr.String)
	t.LastError = t.lastError.String()
	if err := json.Unmarshal([]byte(evs), &t.Events); err != nil {
		return t, fmt.Errorf("target %s: events: %w", t.ID, err)
	}
	return t, nil
}

// unreadableEvents is the error shown on a listed target whose saved events are not valid JSON.
const unreadableEvents = "Its events can't be read. Choose them again and save it."

// Targets lists the saved targets, oldest first. A target whose events can't be read is listed
// with no events and an error, instead of failing the whole list. Choosing its events and saving
// it again fixes it.
func (s *Service) Targets(ctx context.Context) ([]NotificationTarget, error) {
	var out []NotificationTarget
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT `+targetCols+` FROM notification_targets ORDER BY created_ms, rowid`)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			t, err := s.scanTarget(rows)
			if err != nil {
				if t.ID == "" {
					return err
				}
				t.Events, t.lastError = nil, i18n.M(unreadableEvents)
				t.LastError = t.lastError.String()
			}
			out = append(out, t)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("list notification targets: %w", err)
	}
	return out, nil
}

// Target returns one saved target, or ErrTargetNotFound.
func (s *Service) Target(ctx context.Context, id string) (NotificationTarget, error) {
	return s.target(ctx, id)
}

func (s *Service) target(ctx context.Context, id string) (NotificationTarget, error) {
	var t NotificationTarget
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		var err error
		t, err = s.scanTarget(tx.QueryRowContext(ctx, `SELECT `+targetCols+` FROM notification_targets WHERE id = ?`, id))
		return err
	})
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrTargetNotFound
	}
	return t, err
}

func (s *Service) Create(ctx context.Context, in TargetInput) (NotificationTarget, error) {
	return s.save(ctx, uuid.NewString(), in, true)
}

// Update replaces a saved target's name, url, events and enabled switch. Its provider doesn't
// change.
func (s *Service) Update(ctx context.Context, id string, in TargetInput) (NotificationTarget, error) {
	return s.save(ctx, id, in, false)
}

func (s *Service) save(ctx context.Context, id string, in TargetInput, create bool) (NotificationTarget, error) {
	in.Name, in.URL = strings.TrimSpace(in.Name), strings.TrimSpace(in.URL)
	var events []NotificationEvent
	for _, e := range in.Events {
		if !slices.Contains(events, e) {
			events = append(events, e)
		}
	}
	in.Events = events
	evs, err := json.Marshal(events)
	if err != nil {
		return NotificationTarget{}, err
	}
	now := db.NowMS()
	var saved NotificationTarget
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		if !create {
			var provider NotificationProvider
			err := tx.QueryRowContext(ctx, `SELECT provider FROM notification_targets WHERE id = ?`, id).Scan(&provider)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrTargetNotFound
			}
			if err != nil {
				return err
			}
			if in.Provider != "" && in.Provider != provider {
				return errs.Field("provider", "A notification's provider cannot change.")
			}
			in.Provider = provider
		}
		if err := firstProblem(in.problems(), "provider", "name", "url", "chatId", "events"); err != nil {
			return err
		}
		key := urlKey(in.URL)
		var taken bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM notification_targets WHERE url_key = ? AND id <> ?)`, key, id).Scan(&taken)
		if err != nil {
			return err
		}
		if taken {
			return duplicate(in.Provider)
		}
		if create {
			_, err = tx.ExecContext(ctx, `INSERT INTO notification_targets
				(id, name, provider, url, url_key, events, enabled, created_ms, updated_ms)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id, in.Name, string(in.Provider), in.URL, key, string(evs), in.IsEnabled, now, now)
		} else {
			_, err = tx.ExecContext(ctx, `UPDATE notification_targets
				SET name = ?, url = ?, url_key = ?, events = ?, enabled = ?, updated_ms = ? WHERE id = ?`,
				in.Name, in.URL, key, string(evs), in.IsEnabled, now, id)
		}
		if err != nil {
			return err
		}
		saved, err = s.scanTarget(tx.QueryRowContext(ctx, `SELECT `+targetCols+` FROM notification_targets WHERE id = ?`, id))
		return err
	})
	if err != nil {
		return NotificationTarget{}, wrapTarget("save", err)
	}
	s.changed()
	return saved, nil
}

// Delete removes a target. A target that is already gone is not an error.
func (s *Service) Delete(ctx context.Context, id string) error {
	n, err := s.exec(ctx, `DELETE FROM notification_targets WHERE id = ?`, id)
	if err != nil {
		return wrapTarget("delete", err)
	}
	if n > 0 {
		s.changed()
	}
	return nil
}

func (s *Service) SetEnabled(ctx context.Context, id string, enabled bool) error {
	n, err := s.exec(ctx, `UPDATE notification_targets SET enabled = ?, updated_ms = ? WHERE id = ?`, enabled, db.NowMS(), id)
	if err != nil {
		return wrapTarget("switch", err)
	}
	if n == 0 {
		return ErrTargetNotFound
	}
	s.changed()
	return nil
}

// record saves a delivery's outcome on its target, unless the target has been deleted since. The
// error is saved with i18n.Save, so that a page can show it later in the language the app has
// then.
func (s *Service) record(ctx context.Context, id string, sendErr error) {
	var lastErr any
	if sendErr != nil {
		lastErr = i18n.Save(sendErr)
	}
	n, err := s.exec(ctx, `UPDATE notification_targets SET last_sent_ms = ?, last_error = ? WHERE id = ?`, db.NowMS(), lastErr, id)
	if err != nil {
		s.log.ErrorContext(ctx, "recording a delivery failed", "target", id, "error", err)
		return
	}
	if n > 0 {
		s.changed()
	}
}

func (s *Service) exec(ctx context.Context, query string, args ...any) (int64, error) {
	var n int64
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		return err
	})
	return n, err
}

func (s *Service) changed() { s.bus.Publish(bus.NotificationsChanged, nil) }

// wrapTarget adds context to err, but returns the errors that a page shows unchanged.
func wrapTarget(what string, err error) error {
	var ae *errs.FieldError
	if errors.As(err, &ae) || errors.Is(err, ErrTargetNotFound) {
		return err
	}
	return fmt.Errorf("%s notification target: %w", what, err)
}

// subscribed returns the enabled targets that want event. A target that can't be read is
// returned separately, as its id and the error, so the error can be recorded on it. That
// includes a target whose events are not valid JSON. The query guards against those, because
// json_each would otherwise fail the whole query, and with it every other target's delivery.
func (s *Service) subscribed(ctx context.Context, event NotificationEvent) ([]NotificationTarget, map[string]error, error) {
	var out []NotificationTarget
	broken := map[string]error{}
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT `+targetCols+` FROM notification_targets
			WHERE enabled = 1 AND (NOT json_valid(events) OR EXISTS (SELECT 1
				FROM json_each(CASE WHEN json_valid(events) THEN events ELSE '[]' END) WHERE value = ?))
			ORDER BY created_ms, rowid`, string(event))
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			t, err := s.scanTarget(rows)
			if err != nil {
				if t.ID == "" {
					return err
				}
				broken[t.ID] = err
				continue
			}
			out = append(out, t)
		}
		return rows.Err()
	})
	return out, broken, err
}
