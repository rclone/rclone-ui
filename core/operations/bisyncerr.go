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

// These are the errors that a bisync step ends with when it can't go on by itself. They are worded
// so that BisyncTroubleOf can read them back from a transfer's recorded error, which is in
// English. The errors are translated when they are shown.
const (
	// noListings starts the error of a bisync that has no listings from an earlier run. These
	// are rclone's own words. IsFirstRun looks for them.
	noListings = "cannot find prior Path1 or Path2 listings"
	// needsResync starts the error of a bisync that rclone stopped with a critical error,
	// after which it set its listings aside. Only a resync can run again.
	needsResync = "bisync needs a resync"
	// needsMerge starts the error of a bisync that found an empty listing from its last run:
	// bisync won't go on from an empty side. The last merge left the side empty, so both sides
	// were empty, and a merge can't lose anything.
	needsMerge = "bisync needs a merge"
	// allDeleted starts the error of a bisync that found one side empty although its last run
	// listed files there: every file on that side was deleted, or the side isn't there (a drive
	// that isn't mounted). Even force won't go on from an empty side.
	allDeleted = "every file was deleted"
	// tooManyDeletes starts the error of a bisync that stopped because more than half the files
	// on one side were deleted (its max-delete safety). These are rclone's own words.
	tooManyDeletes = "too many deletes"
)

// BisyncTrouble is why a bisync can't go on by itself.
type BisyncTrouble string

const (
	// TroubleNone is a failure that the next run may fix, or no failure.
	TroubleNone BisyncTrouble = ""
	// TroubleResync needs a resync: rclone had a critical error, or its listings are gone.
	TroubleResync BisyncTrouble = "resync"
	// TroubleDeletes is the max-delete safety's stop: many files were deleted on one side.
	TroubleDeletes BisyncTrouble = "deletes"
	// TroubleMerge needs a merge, which is safe: the last run left a side empty.
	TroubleMerge BisyncTrouble = "merge"
	// TroubleEmptied is a side that lost every file since the last run. bisync won't run with
	// an empty side, even with force.
	TroubleEmptied BisyncTrouble = "emptied"
)

// BisyncTroubleOf reads why a bisync failed from its transfer's recorded error. For
// TroubleDeletes and TroubleEmptied, side is the folder that lost the files (1 for Path1, 2 for
// Path2), or 0 when rclone didn't say.
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

// IsFirstRun reports whether a bisync failed because it had no listings from an earlier run,
// which means that the two folders were never synced together. errText is the transfer's error.
func IsFirstRun(errText string) bool { return strings.HasPrefix(errText, noListings) }

// heardBisync is what rclone logged during a bisync that its error leaves out: which side lost
// too many files, and the critical error it stopped with.
type heardBisync struct {
	// deletedSide is 1 or 2 for the side that the max-delete safety stopped on, or 0.
	deletedSide int
	// critical is the critical error, or "".
	critical string
}

// hearBisync listens to rclone's log during a bisync of name1 and name2 (the Fs paths of its two
// sides, as bilib.FsPath writes them). bisync logs which side lost too many files, and its
// critical error, but returns neither. rclone's lines carry no context, so a line from another
// bisync could be heard too:
//   - The side's line names its path, so only a line about these paths counts.
//   - A critical error's line that names this run's listings (base, bilib.BasePath) is this run's.
//   - Any other critical error's line names no path, so it is only kept when no other bisync ran
//     at any time during this one.
//
// The returned function stops listening and returns what was heard.
func hearBisync(name1, name2, base string) func() heardBisync {
	var (
		mu    sync.Mutex
		heard heardBisync
		own   string // a critical line that names this run's listings
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

// criticalPrefix starts the line that bisync logs its critical error with.
const criticalPrefix = "Bisync critical error: "

// ansi matches the terminal colour codes that bisync puts around some of its lines.
var ansi = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]")

func stripANSI(s string) string { return ansi.ReplaceAllString(s, "") }

// bisyncs tracks the bisyncs in flight, so that a line that names no path is only attributed to
// a bisync that ran alone.
var bisyncs = &flight{runs: map[int]*bool{}}

type flight struct {
	mu   sync.Mutex
	next int
	// runs holds, for each bisync in flight, whether another one ran at the same time.
	runs map[int]*bool
}

// begin records a bisync that starts, and returns its key.
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

// end records that the bisync key ended, and reports whether it ran alone throughout.
func (f *flight) end(key int) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	shared := f.runs[key]
	delete(f.runs, key)
	return shared != nil && !*shared
}

// deletedSide returns the side that a max-delete line is about, 1 or 2, when the line names that
// side's path as rclone quotes it. It returns 0 otherwise.
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

// bisyncError returns the error of a bisync that ran, in words that BisyncTroubleOf reads back
// when the bisync can't go on by itself. A resync or a dry run is left as it is.
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
	// bisync won't go on from an empty listing (checkListing), and says which in its critical
	// error. An empty prior listing is what the last run left: both sides were empty.
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

// withReason adds the critical error that bisync logged to an abort, which says only "bisync
// aborted".
func withReason(err error, heard heardBisync) error {
	if errors.Is(err, bisync.ErrBisyncAborted) && heard.critical != "" {
		return fmt.Errorf("%w: %s", err, heard.critical)
	}
	return err
}
