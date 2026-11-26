package transfers

import (
	"context"
	"errors"
	"slices"
)

const (
	trackedMax   = 50
	trackedFiles = 50
)

// TrackedTransfer is the current state of one transfer that a page started (a drop, a folder
// rename or delete, or a batch rename). A running transfer has no Files yet.
type TrackedTransfer struct {
	Transfer `json:"transfer"`
	// Files are the files that the transfer has finished with, newest first: at most 50
	// transferred and 50 failed.
	Files []File `json:"files"`
}

func (s *Service) Tracked(ctx context.Context, ids []string) ([]TrackedTransfer, error) {
	var list []string
	for _, id := range ids {
		if id != "" && !slices.Contains(list, id) {
			list = append(list, id)
		}
	}
	list = list[max(0, len(list)-trackedMax):]
	out := []TrackedTransfer{}
	for _, id := range list {
		t, err := s.trackedOne(ctx, id)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return out, err
		}
		out = append(out, t)
	}
	return out, nil
}

func (s *Service) trackedOne(ctx context.Context, id string) (TrackedTransfer, error) {
	tr, err := s.get(ctx, id)
	if err != nil {
		return TrackedTransfer{}, err
	}
	t := TrackedTransfer{Transfer: tr, Files: []File{}}
	if tr.EndedAt == nil {
		return t, nil
	}
	for _, outcome := range []Outcome{OutcomeTransferred, OutcomeFailed} {
		page, err := s.Files(ctx, id, FilesQuery{Outcome: outcome, Limit: trackedFiles})
		if err != nil {
			return t, err
		}
		t.Files = append(t.Files, page.Items...)
	}
	return t, nil
}
