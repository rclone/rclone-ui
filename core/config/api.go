package config

import (
	"context"

	"github.com/rclone/rclone-ui/core/internal/late"
)

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

func shown(c *ConfigFile, err error) (*ConfigFile, error) { return c.shown(), err }

func (a *API) Get(ctx context.Context) (ConfigFile, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*ConfigFile, error) { return shown(s.Get(ctx)) })
}

func (a *API) Unlock(ctx context.Context, password string, remember bool) (ConfigFile, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*ConfigFile, error) { return shown(s.Unlock(ctx, password, remember)) })
}

// SetPassword encrypts the config, or changes its password.
func (a *API) SetPassword(ctx context.Context, password string, remember bool) (ConfigFile, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*ConfigFile, error) { return shown(s.SetPassword(ctx, password, remember)) })
}

func (a *API) RemovePassword(ctx context.Context) (ConfigFile, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*ConfigFile, error) { return shown(s.RemovePassword(ctx)) })
}

// ForgetPassword takes the config's password out of the keychain.
func (a *API) ForgetPassword(ctx context.Context) (ConfigFile, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*ConfigFile, error) { return shown(s.ForgetPassword(ctx)) })
}

// SetPasswordCommand sets the command that gives the config's password, or removes it when
// command is "".
func (a *API) SetPasswordCommand(ctx context.Context, command string) (ConfigFile, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*ConfigFile, error) { return shown(s.SetPasswordCommand(ctx, command)) })
}

func (a *API) ReadText(ctx context.Context) (string, error) {
	return late.Call(ctx, a.s, func(s *Service) (string, error) { return s.ReadText(ctx) })
}

func (a *API) WriteText(ctx context.Context, text string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.WriteText(ctx, text) })
}

func (a *API) Export(ctx context.Context, path string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Export(ctx, path) })
}
