package operations

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/rclone/rclone/cmd/bisync"
	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/logs/rclonelog"
)

const (
	noListings  = "cannot find prior Path1 or Path2 listings"
	needsResync = "bisync needs a resync"
	needsMerge  = "bisync needs a merge"
	allDeleted  = "every file was deleted"
	// rclone's own words.
	tooManyDeletes = "too many deletes"
)

type BisyncTrouble string

const (
	TroubleNone    BisyncTrouble = ""
	TroubleResync  BisyncTrouble = "resync"
	TroubleDeletes BisyncTrouble = "deletes"
	TroubleMerge   BisyncTrouble = "merge"
	TroubleEmptied BisyncTrouble = "emptied"
)

func BisyncTroubleOf(errText string) (trouble BisyncTrouble, side int) {
	switch {
	case strings.HasPrefix(errText, tooManyDeletes):
		switch {
		case strings.HasPrefix(errText, tooManyDeletes+" on Path1"):
			side = 1
		case strings.HasPrefix(errText, tooManyDeletes+" on Path2"):
			side = 2
		}
		return TroubleDeletes, side
	case strings.HasPrefix(errText, needsResync), strings.HasPrefix(errText, noListings):
		return TroubleResync, 0
	case strings.HasPrefix(errText, needsMerge):
		return TroubleMerge, 0
	case strings.HasPrefix(errText, allDeleted+" on Path1"):
		return TroubleEmptied, 1
	case strings.HasPrefix(errText, allDeleted+" on Path2"):
		return TroubleEmptied, 2
	}
	return TroubleNone, 0
}

// WhatBisyncBaseline is the What of the error that a first bisync's start returns: the two
// folders have no baseline yet, and a resync must set one. The Bisync page offers that resync.
const WhatBisyncBaseline = "bisync_baseline"

func IsFirstRun(errText string) bool { return strings.HasPrefix(errText, noListings) }

type heardBisync struct {
	deletedSide int
	critical    string
}

// bisync logs which side lost too many files, and its critical error, but returns neither.
// rclone's lines carry no context, so a line from another bisync could be heard too.
func hearBisync(name1, name2, base string) func() heardBisync {
	var (
		mu    sync.Mutex
		heard heardBisync
		own   string
	)
	self := bisyncs.begin()
	stop := rclonelog.Watch(func(level slog.Level, msg string) {
		if level < slog.LevelError {
			return
		}
		msg = stripANSI(msg)
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasPrefix(msg, tooManyDeletes+" ("):
			// "too many deletes (>50%, 3 of 4) on Path1 "/x/". Run with --force if desired."
			// Only the first side checked is reported, because bisync stops there.
			if heard.deletedSide == 0 {
				heard.deletedSide = deletedSide(msg, name1, name2)
			}
		case strings.HasPrefix(msg, criticalPrefix):
			text := strings.TrimSpace(strings.TrimPrefix(msg, criticalPrefix))
			if base != "" && strings.Contains(text, base+".path") {
				own = text
			} else {
				heard.critical = text
			}
		}
	})
	return func() heardBisync {
		stop()
		alone := bisyncs.end(self)
		mu.Lock()
		defer mu.Unlock()
		if !alone {
			heard.critical = ""
		}
		if own != "" {
			heard.critical = own
		}
		return heard
	}
}

// emptyListing matches the critical error of a bisync that found an empty listing
// (cmd/bisync/listing.go, checkListing): "empty prior Path1 listing: <file>".
var emptyListing = regexp.MustCompile(`^empty (prior|current) Path([12]) listing`)

const criticalPrefix = "Bisync critical error: "

var ansi = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]")

func stripANSI(s string) string { return ansi.ReplaceAllString(s, "") }

var bisyncs = &flight{runs: map[int]*bool{}}

type flight struct {
	mu   sync.Mutex
	next int
	runs map[int]*bool
}

func (f *flight) begin() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	shared := len(f.runs) > 0
	for _, other := range f.runs {
		*other = true
	}
	key := f.next
	f.next++
	f.runs[key] = &shared
	return key
}

func (f *flight) end(key int) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	shared := f.runs[key]
	delete(f.runs, key)
	return shared != nil && !*shared
}

func deletedSide(msg, path1, path2 string) int {
	names := func(side, path string) bool {
		for _, quoted := range []string{`"` + path + `"`, strconv.Quote(path)} {
			if strings.Contains(msg, " on "+side+" "+quoted) {
				return true
			}
		}
		return false
	}
	switch {
	case names("Path1", path1):
		return 1
	case names("Path2", path2):
		return 2
	}
	return 0
}

func (p Plan) bisyncError(ctx context.Context, err error, path1, path2 fs.Fs, heard heardBisync) error {
	resync, _ := p.Bisync["resync"].(bool)
	if err != nil && (resync || p.DryRun()) {
		return withReason(err, heard)
	}
	if err == nil {
		return nil
	}
	if err.Error() == tooManyDeletes {
		switch heard.deletedSide {
		case 1:
			// i18n: Path1 and Path2 are rclone's names for the two folders of a bisync. "force" is the bisync option of that name.
			return errs.Errorf(tooManyDeletes + " on Path1: bisync stopped before deleting the same files on Path2. Run it with force to delete them there too")
		case 2:
			// i18n: Path1 and Path2 are rclone's names for the two folders of a bisync. "force" is the bisync option of that name.
			return errs.Errorf(tooManyDeletes + " on Path2: bisync stopped before deleting the same files on Path1. Run it with force to delete them there too")
		}
		// i18n: "force" is the bisync option of that name.
		return errs.Errorf(tooManyDeletes + ": bisync stopped before deleting the same files on the other side. Run it with force to delete them there too")
	}
	if errors.Is(err, bisync.ErrBisyncAborted) {
		if m := emptyListing.FindStringSubmatch(heard.critical); m != nil {
			if m[1] == "prior" {
				// i18n: A merge is a bisync option. The values are rclone's critical error and its abort, in English.
				return errs.Errorf(needsMerge+": %s: %w", heard.critical, err)
			}
			// i18n: The first value is 1 or 2, for rclone's Path1 or Path2. Then rclone's critical error and its abort, in English.
			return errs.Errorf(allDeleted+" on Path%s since the last sync: %s: %w", m[2], heard.critical, err)
		}
	}
	// After a critical error that --resilient can't retry, bisync renames its listings, so the
	// next run would find none.
	if errors.Is(err, bisync.ErrBisyncAborted) && p.firstBisync(ctx, path1, path2) {
		if heard.critical != "" {
			// i18n: A resync is a bisync option. The values are rclone's critical error and its abort, in English.
			return errs.Errorf(needsResync+": %s: %w", heard.critical, err)
		}
		// i18n: A resync is a bisync option. The value is rclone's error, in English.
		return errs.Errorf(needsResync+": %w", err)
	}
	return withReason(err, heard)
}

func withReason(err error, heard heardBisync) error {
	if errors.Is(err, bisync.ErrBisyncAborted) && heard.critical != "" {
		return fmt.Errorf("%w: %s", err, heard.critical)
	}
	return err
}
