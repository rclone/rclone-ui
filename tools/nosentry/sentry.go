// Package sentry stands in for github.com/getsentry/sentry-go (see go.mod). It has only what the
// built-in cloudflared calls, and nothing is ever sent.
package sentry

import "time"

type ClientOptions struct {
	Dsn     string
	Release string
}

type EventID string

type Hub struct{}

func Init(ClientOptions) error { return nil }

func CurrentHub() *Hub { return &Hub{} }

func (h *Hub) Clone() *Hub { return h }

func (*Hub) CaptureException(error) *EventID { return nil }

func (*Hub) Recover(any) *EventID { return nil }

func CaptureException(error) *EventID { return nil }

func Flush(time.Duration) bool { return true }
