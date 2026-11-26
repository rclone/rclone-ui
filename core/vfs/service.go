package vfs

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/errs"
)

const forgetWait = 10 * time.Second

var ErrNotFound = errs.NotFound("vfs", "This mount or serve is not running any more.")

type Target struct {
	ID, Kind, Fs, Name string
	RC                 *children.RC
}

type Source func() []Target

type Service struct {
	sources []Source
}

func New(sources ...Source) *Service { return &Service{sources: sources} }

func (s *Service) List() []Target {
	var out []Target
	for _, src := range s.sources {
		for _, t := range src() {
			if t.RC != nil {
				out = append(out, t)
			}
		}
	}
	slices.SortFunc(out, func(a, b Target) int {
		return cmp.Or(strings.Compare(a.Kind, b.Kind), strings.Compare(a.Name, b.Name), strings.Compare(a.ID, b.ID))
	})
	return out
}

func (s *Service) Forget(ctx context.Context, id string) error {
	list := s.List()
	if id != "" {
		i := slices.IndexFunc(list, func(t Target) bool { return t.ID == id })
		if i < 0 {
			return ErrNotFound
		}
		list = list[i : i+1]
	}
	var errs []error
	for _, t := range list {
		fctx, cancel := context.WithTimeout(ctx, forgetWait)
		_, err := t.RC.Call(fctx, "vfs/forget", nil)
		cancel()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", t.Name, err))
		}
	}
	return errors.Join(errs...)
}
