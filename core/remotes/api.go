package remotes

import (
	"context"
	"errors"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/filen"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone/fs"
)

// FsInfoView describes what a remote's backend can do, as the pages read it.
type FsInfoView struct {
	Features map[string]bool `json:"features"`
	// MetadataInfo describes the metadata that the backend keeps, or is nil when it keeps none.
	MetadataInfo *fs.MetadataInfo `json:"metadataInfo"`
	Hashes       []string         `json:"hashes"`
	// Precision is the modification-time precision, in ns.
	Precision int64 `json:"precision"`
}

type Remote struct {
	Name   string      `json:"name"`
	Type   string      `json:"type"`
	Fsinfo *FsInfoView `json:"fsinfo"`
}

type RemoteValues struct {
	Type   string            `json:"type"`
	Values map[string]string `json:"values"`
}

type SessionRequest struct {
	// Kind is create, update or reconnect.
	Kind string `json:"kind"`
	Name string `json:"name"`
	// NewName is the edit form's Name field, for update.
	NewName string `json:"newName"`
	// Type is the backend, for create.
	Type string `json:"type"`
	// Values holds every value for create, or the changed ones for update.
	Values map[string]string `json:"values"`
	// NonInteractive asks rclone's questions one at a time.
	NonInteractive bool `json:"nonInteractive"`
}

// ConfigStep is a config session as the pages see it.
type ConfigStep struct {
	ID     string `json:"id"`
	Remote string `json:"remote"`
	// Kind is create, update or reconnect.
	Kind string `json:"kind"`
	// State is question, authorize, working, done, failed or cancelled.
	State  string `json:"state"`
	Notice string `json:"notice"`
	// AuthURL is rclone's sign-in link, while it waits for a sign-in.
	AuthURL string `json:"authUrl"`
	Error   string `json:"error"`
	// Field is the form field that Error is about: newName for a rename that failed.
	Field string `json:"field"`
	// ResultName is the remote's name when done, which is the new name after a rename.
	ResultName   string   `json:"resultName"`
	NotRewritten []string `json:"notRewritten"`
	// Question is rclone's question, while State is question.
	Question *catalog.Option `json:"question"`
	// Busy explains why a session failed when another program holds the port of rclone's sign-in
	// listener. It holds the listener's address.
	Busy string `json:"busy"`
}

// ClaimResult is the result of a reconnect prompt's claim: either granted, or the current holder.
type ClaimResult struct {
	Granted bool   `json:"granted"`
	Holder  string `json:"holder"`
}

type API struct{ s *late.Value[*Service] }

func NewAPI(s *late.Value[*Service]) *API { return &API{s: s} }

// fsinfoView returns what a page reads of a remote's features. The help of its metadata is
// rclone's, in the app's language (catalog.LocalMetadataInfo). typ is the remote's backend.
func fsinfoView(typ string, fi *FSInfo) *FsInfoView {
	if fi == nil {
		return nil
	}
	return &FsInfoView{
		Features: fi.Features, MetadataInfo: catalog.LocalMetadataInfo(typ, fi.MetadataInfo),
		Hashes: fi.Hashes, Precision: fi.Precision,
	}
}

// stepError returns why a step failed, in the app's language. An error that rclone ended the
// setup with is one of its setup texts, which are translated by backend (catalog.LocalNotice).
func stepError(st *Step) string {
	var refused setupError
	if errors.As(st.Error, &refused) {
		return catalog.LocalNotice(st.Type, string(refused))
	}
	return i18n.Localize(st.Error)
}

// stepView returns a session's step as the pages read it, with its texts in the app's language.
func stepView(st *Step) *ConfigStep {
	if st == nil {
		return nil
	}
	out := &ConfigStep{
		ID: st.ID, Remote: st.Remote, Kind: st.Kind, State: st.State, Notice: catalog.LocalNotice(st.Type, st.Notice),
		AuthURL: st.AuthURL, Error: stepError(st), Field: st.Field, Busy: st.Busy,
	}
	if st.Busy == unknownPort {
		// i18n: Stands for the address of rclone's sign-in listener, in "Another app is using the port rclone signs in on (…)".
		out.Busy = i18n.T(unknownPort)
	}
	if st.Question != nil {
		out.Question = catalog.FromQuestion(st.Type, st.Question)
	}
	if st.Result != nil {
		out.ResultName = st.Result.Name
		for _, err := range st.Result.NotRewritten {
			out.NotRewritten = append(out.NotRewritten, i18n.Localize(err))
		}
	}
	return out
}

func (a *API) List(ctx context.Context) ([]Remote, error) {
	return late.Call(ctx, a.s, func(s *Service) ([]Remote, error) {
		list, err := s.List(ctx)
		if err != nil {
			return nil, err
		}
		out := make([]Remote, 0, len(list))
		for _, r := range list {
			out = append(out, Remote{Name: r.Name, Type: r.Type, Fsinfo: fsinfoView(r.Type, r.FSInfo)})
		}
		return out, nil
	})
}

func (a *API) Get(ctx context.Context, name string) (RemoteValues, error) {
	return late.Call(ctx, a.s, func(s *Service) (RemoteValues, error) {
		typ, values, err := s.Values(name)
		if err != nil {
			return RemoteValues{}, err
		}
		return RemoteValues{Type: typ, Values: values}, nil
	})
}

func (a *API) Health(ctx context.Context) (map[string]HealthResult, error) {
	return late.Call(ctx, a.s, func(s *Service) (map[string]HealthResult, error) {
		out := s.Health(ctx)
		for name, r := range out {
			out[name] = r.shown()
		}
		return out, nil
	})
}

// Recheck forgets the health results, so every remote is checked again.
func (a *API) Recheck(ctx context.Context) error {
	return a.s.Do(ctx, func(s *Service) error {
		s.Recheck()
		return nil
	})
}

// CheckRemote checks one remote again, for its edit form. Health reports checking until the
// check finishes, and remotes.health reports its result.
func (a *API) CheckRemote(ctx context.Context, name string) error {
	return a.s.Do(ctx, func(s *Service) error {
		if !s.exists(name) {
			return ErrNotFound
		}
		s.CheckRemote(name)
		return nil
	})
}

// CheckName explains what is wrong with a new remote's name, or returns "" when nothing is.
func (a *API) CheckName(ctx context.Context, name string) (string, error) {
	return late.Call(ctx, a.s, func(s *Service) (string, error) { return i18n.Localize(s.CheckName(name)), nil })
}

func (a *API) Delete(ctx context.Context, name string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Delete(ctx, name) })
}

// StartSession begins creating, editing or reconnecting a remote. The session goes through
// rclone's questions and its sign-in link, and ends as done or failed. Only one session runs at a
// time, and a new one ends the previous one.
func (a *API) StartSession(ctx context.Context, req SessionRequest) (ConfigStep, error) {
	return late.CallValue(ctx, a.s, func(s *Service) (*ConfigStep, error) {
		values := make(map[string]any, len(req.Values))
		for k, v := range req.Values {
			values[k] = v
		}
		st, err := s.Sessions().Start(ctx, StartRequest{
			Kind: req.Kind, Name: req.Name, NewName: req.NewName, Type: req.Type,
			Values: values, NonInteractive: req.NonInteractive,
		})
		if err != nil {
			return nil, err
		}
		return stepView(&st), nil
	})
}

// CurrentSession returns the running or just finished session, or nil when there is none.
func (a *API) CurrentSession(ctx context.Context) (*ConfigStep, error) {
	return late.Call(ctx, a.s, func(s *Service) (*ConfigStep, error) { return stepView(s.Sessions().Current(ctx)), nil })
}

func (a *API) Answer(ctx context.Context, id, value string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Sessions().Answer(ctx, id, value) })
}

func (a *API) CancelSession(ctx context.Context, id string) error {
	return a.s.Do(ctx, func(s *Service) error { return s.Sessions().Cancel(ctx, id) })
}

// Claim gives a remote's reconnect prompt to one window at a time. holder identifies the window.
func (a *API) Claim(ctx context.Context, name, holder string) (ClaimResult, error) {
	return late.Call(ctx, a.s, func(s *Service) (ClaimResult, error) {
		c := s.Claims().Claim(name, holder)
		return ClaimResult{Granted: c.Granted, Holder: c.Holder}, nil
	})
}

func (a *API) Release(ctx context.Context, name, holder string) error {
	return a.s.Do(ctx, func(s *Service) error {
		s.Claims().Release(name, holder)
		return nil
	})
}

// FilenAPIKey logs in to a Filen account the way `filen export-api-key` does, and returns its API
// key. For an account with two-factor authentication, it returns an error on `code` until the
// code is given.
func (a *API) FilenAPIKey(ctx context.Context, email, password, code string) (string, error) {
	return filen.APIKey(ctx, email, password, code)
}
