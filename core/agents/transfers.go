package agents

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/rclone/rclone/fs/fspath"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/templates"
	"github.com/rclone/rclone-ui/core/transfers"
)

const (
	transferListDefault = 20
	transferListMax     = 100
	// transferChangedShown, transferFailedShown and transferCheckedShown are how many files of
	// each outcome get_transfer lists.
	transferChangedShown = 100
	transferFailedShown  = 50
	transferCheckedShown = 20
	// transferChangedRead is how many changed files get_transfer reads, to put the deletions
	// first. The record keeps the newest 1,000 of them, and a page holds at most 200.
	transferChangedRead = 1000
	transferFilesPage   = 200
	// transferWaitDefault and transferWaitMax are wait_for_transfer's default and longest
	// timeouts, in seconds.
	transferWaitDefault = 30
	transferWaitMax     = 120
	// transferWaitPoll is how often wait_for_transfer reads the transfer again.
	transferWaitPoll = 250 * time.Millisecond
)

type transferStarted struct {
	TransferID string `json:"transfer_id" jsonschema:"the transfer's id, for wait_for_transfer, get_transfer and stop_transfer"`
	Number     int64  `json:"number" jsonschema:"the transfer's number, which the app's History window shows as #12"`
	// IgnoredOptions are the options that the operation doesn't take. It runs without them.
	IgnoredOptions []ignoredTransferOption `json:"ignored_options" jsonschema:"the options that this operation doesn't take, each with the reason. The transfer runs without them"`
}

type ignoredTransferOption struct {
	Option string `json:"option"`
	Reason string `json:"reason"`
}

// transferCopyIn is what copy and move take.
type transferCopyIn struct {
	Sources     []string       `json:"sources" jsonschema:"the files and folders, such as [\"gdrive:Photos/2024\", \"/Users/me/notes.txt\"]"`
	Destination string         `json:"destination" jsonschema:"the folder that they go into, such as \"s3:backup\""`
	Options     map[string]any `json:"options,omitempty" jsonschema:"rclone's options by name, such as {\"max_age\": \"7d\", \"exclude\": [\"*.tmp\"]}"`
	DryRun      bool           `json:"dry_run,omitempty" jsonschema:"only find out what would be done, and change nothing"`
}

type transferSyncIn struct {
	Source      string         `json:"source" jsonschema:"the folder to copy from, such as \"/Users/me/Documents\". It is not changed"`
	Destination string         `json:"destination" jsonschema:"the folder to make identical to the source, such as \"gdrive:Documents\""`
	Options     map[string]any `json:"options,omitempty" jsonschema:"rclone's options by name, such as {\"exclude\": [\"*.tmp\"]}"`
	DryRun      bool           `json:"dry_run,omitempty" jsonschema:"only find out what would be copied and deleted, and change nothing"`
}

type transferBisyncIn struct {
	Path1   string         `json:"path1" jsonschema:"one of the two folders, such as \"/Users/me/Notes\""`
	Path2   string         `json:"path2" jsonschema:"the other folder, such as \"gdrive:Notes\""`
	Options map[string]any `json:"options,omitempty" jsonschema:"rclone's options by name, such as {\"exclude\": [\"*.tmp\"]}"`
	DryRun  bool           `json:"dry_run,omitempty" jsonschema:"only find out what would be copied and deleted, and change nothing"`
	Resync  bool           `json:"resync,omitempty" jsonschema:"set the baseline: needed for the first run of two folders, and after bisync asks for it"`
}

type transferDeleteIn struct {
	Paths   []string       `json:"paths" jsonschema:"the folders whose files are deleted, or files, such as [\"gdrive:Old/2019\"]"`
	Options map[string]any `json:"options,omitempty" jsonschema:"rclone's filter options, which narrow what is deleted, such as {\"min_age\": \"1y\"} for the files older than a year"`
	DryRun  bool           `json:"dry_run,omitempty" jsonschema:"only find out which files would be deleted, and delete nothing"`
}

type transferPurgeIn struct {
	Paths  []string `json:"paths" jsonschema:"the folders to delete with everything in them, such as [\"gdrive:Old/2019\"]"`
	DryRun bool     `json:"dry_run,omitempty" jsonschema:"only check the folders, and delete nothing"`
}

type transferDownloadIn struct {
	URL         string `json:"url" jsonschema:"the web link, such as \"https://example.com/report.pdf\""`
	Destination string `json:"destination" jsonschema:"the folder to save the file in, such as \"/Users/me/Downloads\""`
	Filename    string `json:"filename,omitempty" jsonschema:"the name to save it as, such as \"report.pdf\". By default, the media's own name or the link's last part"`
}

type transferRow struct {
	TransferID  string   `json:"transfer_id"`
	Number      int64    `json:"number" jsonschema:"the number that History shows, as #12"`
	Operation   string   `json:"operation" jsonschema:"copy, move, sync, bisync, delete, purge, download or cleanup"`
	Sources     []string `json:"sources"`
	Destination string   `json:"destination,omitempty"`
	// State is queued, running, completed, failed, stopped or interrupted.
	State     string         `json:"state" jsonschema:"queued, running, completed, failed, stopped (by someone), or interrupted (the app quit while it ran)"`
	DryRun    bool           `json:"dry_run" jsonschema:"true when it only found out what it would do, and changed nothing"`
	StartedBy transferOrigin `json:"started_by"`
	StartedAt string         `json:"started_at"`
	EndedAt   string         `json:"ended_at,omitempty"`
	// Progress is set while the transfer runs.
	Progress *transferProgress `json:"progress,omitempty"`
}

type transferOrigin struct {
	Kind string `json:"kind" jsonschema:"page or commander (the user, in the app's windows), template, watcher, schedule, or agent (an AI agent)"`
	Name string `json:"name,omitempty" jsonschema:"the template's, the watcher's or the schedule's name, or the agent's"`
}

type transferProgress struct {
	Percent        int    `json:"percent"`
	Bytes          int64  `json:"bytes"`
	TotalBytes     int64  `json:"total_bytes" jsonschema:"the bytes to transfer that rclone has found so far"`
	BytesPerSecond int64  `json:"bytes_per_second"`
	ETASeconds     *int64 `json:"eta_seconds,omitempty" jsonschema:"the time left, when rclone can tell"`
	Files          int64  `json:"files"`
	TotalFiles     int64  `json:"total_files"`
	Errors         int64  `json:"errors,omitempty"`
}

type transferDetail struct {
	transferRow
	// StillRunning is set by wait_for_transfer when its timeout passed first.
	StillRunning bool   `json:"still_running,omitempty" jsonschema:"true when the wait ended before the transfer did: wait again"`
	Error        string `json:"error,omitempty" jsonschema:"why the transfer failed"`
	// Errors are the errors that belong to a step or to the whole transfer, besides Error.
	Errors []transferError `json:"errors,omitempty" jsonschema:"other errors that are not about a single file"`
	// Totals are set once the transfer has ended.
	Totals *transferTotals `json:"totals,omitempty"`
	// RetryableParts is how many parts retry_transfer would run again.
	RetryableParts int `json:"retryable_parts,omitempty" jsonschema:"how many failed parts retry_transfer can run again"`
	// RetryOf is the number of the transfer that this one retries.
	RetryOf int64         `json:"retry_of,omitempty" jsonschema:"the number of the transfer that this one retries"`
	Changed transferFiles `json:"changed" jsonschema:"the files copied, moved, renamed or deleted (in a dry run: that would be), deletions first"`
	Failed  transferFiles `json:"failed" jsonschema:"the files that failed, each with its error"`
	Checked transferFiles `json:"checked" jsonschema:"files that were compared and left as they were"`
}

// transferError is an error about a step of a transfer, or about all of it.
type transferError struct {
	About string `json:"about,omitempty" jsonschema:"the step or path that it is about"`
	Error string `json:"error"`
}

type transferTotals struct {
	Bytes            int64   `json:"bytes" jsonschema:"bytes copied (in a dry run: that would be)"`
	FilesTransferred int64   `json:"files_transferred"`
	FilesChecked     int64   `json:"files_checked"`
	Deleted          int64   `json:"deleted" jsonschema:"files and folders deleted (in a dry run: that would be)"`
	Renamed          int64   `json:"renamed,omitempty"`
	Errors           int64   `json:"errors"`
	DurationSeconds  float64 `json:"duration_seconds"`
}

// transferFiles are a transfer's files with one outcome.
type transferFiles struct {
	Count int `json:"count" jsonschema:"how many files the record holds with this outcome. It keeps up to 1,000; totals has the full numbers"`
	// ByAction counts the changed files by action. It covers only the files that were read.
	ByAction  map[string]int `json:"by_action,omitempty" jsonschema:"how many of the files were copied, deleted, moved or renamed"`
	Files     []transferFile `json:"files"`
	Truncated bool           `json:"truncated,omitempty" jsonschema:"true when files lists only some of them"`
}

type transferFile struct {
	Path string `json:"path" jsonschema:"the file's full path, or its path inside the transfer's folder when the app doesn't know which folder (a deletion's)"`
	// Action is what was done to the file, in plain words (transferFileAction).
	Action string `json:"action" jsonschema:"copy, delete, move, rename (such as a bisync conflict's), or check. For a failed file, what failed"`
	Size   int64  `json:"size"`
	Error  string `json:"error,omitempty"`
}

type transferListIn struct {
	State  string `json:"state,omitempty" jsonschema:"keep only the transfers that are running (or queued), finished, failed or stopped"`
	Search string `json:"search,omitempty" jsonschema:"keep only the transfers that it is found in: their number (#12), operation, paths, error, or who started them"`
	Limit  int    `json:"limit,omitempty" jsonschema:"the most transfers to return: 20 by default, at most 100"`
}

type transferList struct {
	Transfers []transferRow `json:"transfers"`
	Truncated bool          `json:"truncated,omitempty"`
	// More says how to see the transfers left out, when Truncated is set.
	More string `json:"more,omitempty"`
}

type transferIn struct {
	TransferID string `json:"transfer_id" jsonschema:"the transfer's id, or its number as History shows it, such as \"#12\""`
}

type transferWaitIn struct {
	TransferID     string `json:"transfer_id" jsonschema:"the transfer's id, or its number as History shows it, such as \"#12\""`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty" jsonschema:"how long to wait at most: 30 seconds by default, at most 120"`
}

type transferTemplate struct {
	TemplateID  string   `json:"template_id"`
	Name        string   `json:"name"`
	Operations  []string `json:"operations" jsonschema:"what the template is for: copy, move, sync, bisync, delete, purge, mount or serve"`
	Sources     []string `json:"sources,omitempty"`
	Destination string   `json:"destination,omitempty"`
	// CanRunAs are the operations that run_template runs it as.
	CanRunAs []string `json:"can_run_as" jsonschema:"the operations that run_template can run it as. It needs saved paths"`
}

type transferTemplates struct {
	Templates []transferTemplate `json:"templates"`
}

type transferTemplateIn struct {
	TemplateID string `json:"template_id" jsonschema:"the template's id, from list_templates"`
	Operation  string `json:"operation" jsonschema:"what to run it as: one of the template's can_run_as, such as \"sync\""`
	DryRun     bool   `json:"dry_run,omitempty" jsonschema:"only find out what would be done, and change nothing"`
}

// transferDryRunFirst ends the description of a tool that can delete or overwrite files.
const transferDryRunFirst = " Run it with dry_run first, read what it would do with get_transfer, and tell the user before you run it for real."

// transferStartsAtOnce ends the description of a tool that starts a transfer.
const transferStartsAtOnce = " It runs in the background: this returns the transfer's id at once. Follow it with wait_for_transfer."

func (s *Server) transferTools() {
	add(s, &mcp.Tool{
		Name: "copy",
		Description: "Copies files and folders into a destination folder. Each source lands in the destination under its own name: " +
			"copying \"/Users/me/Photos\" to \"gdrive:Backup\" makes \"gdrive:Backup/Photos\". A remote's root (\"gdrive:\") puts its contents straight into the destination. " +
			"A file that the destination already has is overwritten when the two differ. Copy never deletes anything." + transferStartsAtOnce,
		Annotations: changes("Copy files"),
	}, func(ctx context.Context, in transferCopyIn) (transferStarted, error) {
		groups, ignored, err := transferGroups(operations.OperationCopy, in.Options)
		if err != nil {
			return transferStarted{}, err
		}
		f := operations.CopyArgs{Sources: in.Sources, Destination: in.Destination, Options: groups}.Form()
		return s.startTransfer(ctx, f, in.DryRun, ignored)
	})

	add(s, &mcp.Tool{
		Name: "move",
		Description: "Moves files and folders into a destination folder: each source lands in the destination under its own name, as with copy, " +
			"and its files are then DELETED from the source (its folders can stay behind, empty). " +
			"A file that the destination already has is overwritten when the two differ." + transferDryRunFirst + transferStartsAtOnce,
		Annotations: destroys("Move files"),
	}, func(ctx context.Context, in transferCopyIn) (transferStarted, error) {
		groups, ignored, err := transferGroups(operations.OperationMove, in.Options)
		if err != nil {
			return transferStarted{}, err
		}
		f := operations.MoveArgs{Sources: in.Sources, Destination: in.Destination, Options: groups}.Form()
		return s.startTransfer(ctx, f, in.DryRun, ignored)
	})

	add(s, &mcp.Tool{
		Name: "sync",
		Description: "Makes a destination folder identical to a source folder. It copies the source's new and changed files, overwriting the destination's copies, " +
			"and DELETES every file in the destination that the source doesn't have. The source's contents go straight into the destination, not into a subfolder, " +
			"and the source is not changed. Use copy unless the user asked for a mirror." + transferDryRunFirst + transferStartsAtOnce,
		Annotations: destroys("Sync folders"),
	}, func(ctx context.Context, in transferSyncIn) (transferStarted, error) {
		groups, ignored, err := transferGroups(operations.OperationSync, in.Options)
		if err != nil {
			return transferStarted{}, err
		}
		f := operations.SyncArgs{Source: in.Source, Destination: in.Destination, Options: groups}.Form()
		return s.startTransfer(ctx, f, in.DryRun, ignored)
	})

	add(s, &mcp.Tool{
		Name: "bisync",
		Description: "Syncs two folders both ways. New and changed files on either side are copied to the other, overwriting the older copy, " +
			"and a file deleted on one side is DELETED on the other. A file changed on both sides is kept twice, renamed. " +
			"The first run of two folders needs resync: it copies files both ways so that the two match (where both have a file and they differ, path1's copy wins) and deletes nothing. " +
			"bisync stops by itself before deleting more than half of a side's files: the user can override that in the app's Bisync window." + transferDryRunFirst + transferStartsAtOnce,
		Annotations: destroys("Bisync folders"),
	}, func(ctx context.Context, in transferBisyncIn) (transferStarted, error) {
		groups, ignored, err := transferGroups(operations.OperationBisync, in.Options)
		if err != nil {
			return transferStarted{}, err
		}
		if in.Resync {
			groups.Outer = &operations.BisyncSwitches{Resync: true}
		}
		f := operations.BisyncArgs{Source: in.Path1, Destination: in.Path2, Options: groups}.Form()
		return s.startTransfer(ctx, f, in.DryRun, ignored)
	})

	add(s, &mcp.Tool{
		Name: "delete",
		Description: "DELETES the files inside the given paths and keeps the folders, even when they end up empty. " +
			"A folder has every file in it deleted, in its subfolders too, and a file is deleted. Filter options narrow what is deleted: " +
			"{\"min_age\": \"1y\"} deletes only the files older than a year, and include and exclude take patterns. It refuses a remote's root. " +
			"To delete folders too, use purge." + transferDryRunFirst + transferStartsAtOnce,
		Annotations: destroys("Delete files"),
	}, func(ctx context.Context, in transferDeleteIn) (transferStarted, error) {
		groups, ignored, err := transferGroups(operations.OperationDelete, in.Options)
		if err != nil {
			return transferStarted{}, err
		}
		f := operations.DeleteArgs{Sources: in.Paths, Options: groups}.Form()
		return s.startTransfer(ctx, f, in.DryRun, ignored)
	})

	add(s, &mcp.Tool{
		Name: "purge",
		Description: "DELETES the given folders and everything in them, subfolders included. It takes only folders, never a remote's root, and no filter applies. " +
			"Run it with dry_run first: that checks the folders, but on most remotes it doesn't list the files inside, " +
			"so also list what is in them, and tell the user what will be lost before you run it for real." + transferStartsAtOnce,
		Annotations: destroys("Purge folders"),
	}, func(ctx context.Context, in transferPurgeIn) (transferStarted, error) {
		f := operations.PurgeArgs{Sources: in.Paths}.Form()
		return s.startTransfer(ctx, f, in.DryRun, []ignoredTransferOption{})
	})

	add(s, &mcp.Tool{
		Name: "download",
		Description: "Saves the file behind a web link (http or https) in a folder. For a page of a video or image site that the app knows, it saves the media on the page; " +
			"for any other link, the file at the link. A file of the same name in the folder is overwritten." + transferStartsAtOnce,
		Annotations: changes("Download a link"),
	}, func(ctx context.Context, in transferDownloadIn) (transferStarted, error) {
		return s.startDownload(ctx, in)
	})

	add(s, &mcp.Tool{
		Name: "list_transfers",
		Description: "Lists the transfers in the app's History: the running and queued ones first, then the ended ones, newest first. " +
			"Each has its id, its number (#12 in History), operation, paths, state, whether it was a dry run, who started it, its times, " +
			"and a running one's progress. state and search narrow the list. Returns 20 transfers by default, at most 100.",
		Annotations: reads("List transfers"),
	}, func(ctx context.Context, in transferListIn) (transferList, error) {
		return s.listTransfers(ctx, in)
	})

	add(s, &mcp.Tool{
		Name: "get_transfer",
		Description: "Reads one transfer in full: its state, progress or totals, its errors, and its files by outcome: changed (copied, moved, renamed or deleted), failed and checked. " +
			"For a dry run, nothing was changed: the changed files are what the real run WOULD copy or delete. Report them to the user, deletions first. " +
			"Each list is capped, and its count and totals say how many there are in all.",
		Annotations: reads("Read a transfer"),
	}, func(ctx context.Context, in transferIn) (transferDetail, error) {
		id, err := s.transferID(ctx, in.TransferID)
		if err != nil {
			return transferDetail{}, err
		}
		d, err := s.o.APIs.Transfers.Get(ctx, id)
		if err != nil {
			return transferDetail{}, err
		}
		return s.transferDetailOf(ctx, d)
	})

	add(s, &mcp.Tool{
		Name: "wait_for_transfer",
		Description: "Waits until a transfer ends, or until timeout_seconds pass (30 by default, at most 120), and then returns what get_transfer returns. " +
			"still_running is true when the time ran out first: call it again to keep waiting.",
		Annotations: reads("Wait for a transfer"),
	}, func(ctx context.Context, in transferWaitIn) (transferDetail, error) {
		id, err := s.transferID(ctx, in.TransferID)
		if err != nil {
			return transferDetail{}, err
		}
		timeout := in.TimeoutSeconds
		if timeout <= 0 {
			timeout = transferWaitDefault
		}
		return s.waitTransfer(ctx, id, time.Duration(min(timeout, transferWaitMax))*time.Second)
	})

	add(s, &mcp.Tool{
		Name: "stop_transfer",
		Description: "Stops a running or queued transfer. What it has already copied or deleted stays that way. " +
			"It is recorded as stopped, and returned as list_transfers shows it.",
		Annotations: destroys("Stop a transfer"),
	}, func(ctx context.Context, in transferIn) (transferRow, error) {
		id, err := s.transferID(ctx, in.TransferID)
		if err != nil {
			return transferRow{}, err
		}
		if err := s.o.APIs.Transfers.Stop(ctx, id); err != nil {
			return transferRow{}, err
		}
		d, err := s.o.APIs.Transfers.Get(ctx, id)
		if err != nil {
			return transferRow{}, err
		}
		return transferRowOf(d.Transfer), nil
	})

	add(s, &mcp.Tool{
		Name: "retry_transfer",
		Description: "Runs the parts of an ended transfer that failed again, with the same settings and the same dry run setting, as a new transfer. " +
			"It does what the original did, so the retry of a move, a sync, a bisync, a delete or a purge can delete files. " +
			"get_transfer's retryable_parts says how many parts there are to retry." + transferStartsAtOnce,
		Annotations: destroys("Retry a transfer"),
	}, func(ctx context.Context, in transferIn) (transferStarted, error) {
		id, err := s.transferID(ctx, in.TransferID)
		if err != nil {
			return transferStarted{}, err
		}
		st, err := s.o.APIs.Transfers.Retry(ctx, id, nil)
		if err != nil {
			return transferStarted{}, transferStartError(err)
		}
		return transferStarted{TransferID: st.ID, Number: st.Seq, IgnoredOptions: []ignoredTransferOption{}}, nil
	})

	add(s, &mcp.Tool{
		Name: "list_templates",
		Description: "Lists the user's saved templates: named sets of rclone options that the user made in the app, often with the paths to run them on. " +
			"Each has its id, its name, the operations it is for, its paths, and the operations that run_template can run it as.",
		Annotations: reads("List templates"),
	}, func(ctx context.Context, _ nothing) (transferTemplates, error) {
		list, err := s.o.APIs.Templates.List(ctx)
		if err != nil {
			return transferTemplates{}, err
		}
		out := transferTemplates{Templates: make([]transferTemplate, 0, len(list.Templates))}
		for _, t := range list.Templates {
			out.Templates = append(out.Templates, transferTemplateOf(t))
		}
		return out, nil
	})

	add(s, &mcp.Tool{
		Name: "run_template",
		Description: "Runs a saved template as one of its operations (copy, move, sync, bisync, delete or purge), on its own paths and with its own options. " +
			"A template that moves, syncs, bisyncs, deletes or purges can delete or overwrite files." + transferDryRunFirst + transferStartsAtOnce,
		Annotations: destroys("Run a template"),
	}, func(ctx context.Context, in transferTemplateIn) (transferStarted, error) {
		return s.runSavedTemplate(ctx, in)
	})
}

// transferGroups sorts an agent's flat options into the groups of op's form, as a template's
// options are sorted (operations.TemplateGroups), and returns the options that op doesn't take,
// with the reasons in English.
func transferGroups(op operations.Operation, options map[string]any) (operations.Groups, []ignoredTransferOption, error) {
	flat := catalog.Group{}
	for key, v := range options {
		// The value was read from JSON, so it is written back as it was.
		raw, err := json.Marshal(v)
		if err != nil {
			return operations.Groups{}, nil, fmt.Errorf("the option %s: %w", key, err)
		}
		flat[key] = raw
	}
	groups, skipped, err := operations.TemplateGroups(op, "", flat)
	if err != nil {
		return operations.Groups{}, nil, err
	}
	return groups, transferIgnored(skipped), nil
}

func transferIgnored(skipped []catalog.SkippedFlag) []ignoredTransferOption {
	out := make([]ignoredTransferOption, 0, len(skipped))
	for _, sk := range skipped {
		out = append(out, ignoredTransferOption{Option: sk.Flag, Reason: sk.Reason})
	}
	return out
}

// startTransfer starts the transfer of a form as an operation's window does, with the form as
// its preset, so that History can open the window with it again. The context makes the
// transfer the agent's.
func (s *Server) startTransfer(ctx context.Context, f operations.Form, dryRun bool, ignored []ignoredTransferOption) (transferStarted, error) {
	return s.startTransferWith(ctx, f, f, dryRun, ignored)
}

// startTransferWith is startTransfer with a preset that differs from the form, as a download's
// does.
func (s *Server) startTransferWith(ctx context.Context, f, preset operations.Form, dryRun bool, ignored []ignoredTransferOption) (transferStarted, error) {
	st, err := s.o.APIs.Transfers.Start(ctx, f, transfers.StartOptions{DryRun: dryRun, Origin: transfers.OriginPage, Preset: &preset})
	if err != nil {
		return transferStarted{}, transferStartError(err)
	}
	return transferStarted{TransferID: st.ID, Number: st.Seq, IgnoredOptions: ignored}, nil
}

// transferStartError returns the error of a start as the agent reads it. A transfer that failed
// at once was recorded first, so the error names it, for get_transfer. rclone refuses the first
// bisync of two folders until a resync sets their baseline: the Bisync window offers that resync,
// and the agent is told how to run it.
func transferStartError(err error) error {
	e := errs.Of(err)
	switch {
	case e == nil || e.Transfer == nil:
		return err
	case e.What == operations.WhatBisyncBaseline:
		return errs.New("These two folders have never been bisynced together, so bisync has no baseline to compare them with. " +
			"Run bisync again with resync set to true (with dry_run first): it copies files both ways so that the two folders match " +
			"(where both have a file and they differ, path1's copy wins), and deletes nothing.")
	}
	// i18n: rclone's error, then the number and the id of the transfer that failed. Only AI agents read this.
	return errs.Errorf("%s (The transfer failed as #%d, transfer_id %s: get_transfer shows what failed.)", rclone.ErrorOf(err).Message, e.Transfer.Seq, e.Transfer.ID)
}

// startDownload starts a download as the Download window does. A page of a site that the link
// service knows is looked up, and the media found there is downloaded under its own name. Any
// other link is downloaded as it is, under the last part of its path. The preset keeps the link
// as the agent gave it, so that History's Duplicate looks it up again.
func (s *Server) startDownload(ctx context.Context, in transferDownloadIn) (transferStarted, error) {
	typed := operations.DownloadArgs{URL: strings.TrimSpace(in.URL), Filename: strings.TrimSpace(in.Filename), Destination: in.Destination}
	run := typed
	// The window downloads the link itself when the lookup fails, and so does this.
	if link, err := s.o.APIs.Links.Resolve(ctx, typed.URL); err == nil && link.Found {
		run.URL = link.URL
		if run.Filename == "" {
			run.Filename = link.Filename
		}
	}
	if run.Filename == "" {
		run.Filename = linkFilename(typed.URL)
	}
	if run.Filename == "" {
		return transferStarted{}, errs.New("The link doesn't end in a file name. Give the file a name with filename.")
	}
	return s.startTransferWith(ctx, run.Form(), typed.Form(), false, []ignoredTransferOption{})
}

// linkFilename returns the last part of a link's path, decoded, as the Download window names a
// link's file. It returns "" when the path ends in a slash or the link can't be read.
func linkFilename(link string) string {
	u, err := url.Parse(link)
	if err != nil {
		return ""
	}
	escaped := u.EscapedPath()
	last := escaped[strings.LastIndex(escaped, "/")+1:]
	if last == "" {
		return ""
	}
	// A part that decodes to a path, such as "a%2Fb", is kept as it is written.
	if name, err := url.PathUnescape(last); err == nil && !strings.ContainsAny(name, `/\`) && name != "." && name != ".." {
		return name
	}
	return last
}

// listTransfers lists the open transfers, then the ended ones, newest first.
func (s *Server) listTransfers(ctx context.Context, in transferListIn) (transferList, error) {
	limit := in.Limit
	if limit <= 0 {
		limit = transferListDefault
	}
	limit = min(limit, transferListMax)
	open, ended := true, true
	var state transfers.State
	switch strings.ToLower(strings.TrimSpace(in.State)) {
	case "":
	case "running", "queued":
		ended = false
	case "finished", "completed":
		open, state = false, transfers.StateCompleted
	case "failed":
		open, state = false, transfers.StateFailed
	case "stopped", "interrupted":
		open, state = false, transfers.StateStopped
	default:
		return transferList{}, errs.New("state is running, finished, failed or stopped, or leave it out for every transfer.")
	}

	out := transferList{Transfers: []transferRow{}}
	if open {
		active, err := s.o.APIs.Transfers.ListActive(ctx)
		if err != nil {
			return transferList{}, err
		}
		for _, t := range active {
			if !transfers.Matches(t, in.Search) {
				continue
			}
			if len(out.Transfers) == limit {
				out.Truncated = true
				break
			}
			out.Transfers = append(out.Transfers, transferRowOf(t))
		}
	}
	if ended && !out.Truncated {
		// At least one is asked for, to learn whether the list goes on.
		left := limit - len(out.Transfers)
		page, err := s.o.APIs.Transfers.ListEnded(ctx, transfers.EndedQuery{Limit: max(left, 1), State: state, Search: in.Search})
		if err != nil {
			return transferList{}, err
		}
		items := page.Items[:min(left, len(page.Items))]
		for _, t := range items {
			out.Transfers = append(out.Transfers, transferRowOf(t))
		}
		out.Truncated = page.More || len(items) < len(page.Items)
	}
	if out.Truncated {
		out.More = "There are more transfers. Raise limit (at most 100), or narrow the list with state or search."
	}
	return out, nil
}

// transferID returns the id of the transfer that an agent names: by its id, or by its number as
// History shows it ("#12", or "12").
func (s *Server) transferID(ctx context.Context, named string) (string, error) {
	named = strings.TrimSpace(named)
	if named == "" {
		return "", errs.New("Name the transfer by its transfer_id, or by its number, such as #12.")
	}
	if seq, err := strconv.ParseInt(strings.TrimPrefix(named, "#"), 10, 64); err == nil {
		return s.o.APIs.Transfers.IDOf(ctx, seq)
	}
	return named, nil
}

// waitTransfer reads the transfer every transferWaitPoll until it has ended, the timeout has
// passed, or the call is cancelled. When the timeout passes first, it reads the transfer once
// more and returns it with StillRunning set.
func (s *Server) waitTransfer(ctx context.Context, id string, timeout time.Duration) (transferDetail, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(transferWaitPoll)
	defer tick.Stop()
	late := false
	for {
		d, err := s.o.APIs.Transfers.Get(ctx, id)
		if err != nil {
			return transferDetail{}, err
		}
		if d.EndedAt != nil || late {
			out, err := s.transferDetailOf(ctx, d)
			out.StillRunning = d.EndedAt == nil
			return out, err
		}
		select {
		case <-ctx.Done():
			return transferDetail{}, ctx.Err()
		case <-deadline.C:
			late = true
		case <-tick.C:
		}
	}
}

// transferTime writes a time in milliseconds since the epoch as RFC 3339, in this computer's
// time zone, or "" for no time.
func transferTime(ms int64) string {
	if ms == 0 {
		return ""
	}
	return time.UnixMilli(ms).Format(time.RFC3339)
}

func transferRowOf(t transfers.Transfer) transferRow {
	row := transferRow{
		TransferID: t.ID, Number: t.Seq, Operation: string(t.Operation), Sources: t.Sources,
		Destination: t.Destination, State: string(t.State), DryRun: t.IsDryRun,
		StartedBy: transferOrigin{Kind: string(t.Origin.Kind), Name: t.Origin.Name},
		StartedAt: transferTime(t.CreatedAt),
	}
	if row.Sources == nil {
		row.Sources = []string{}
	}
	if t.StartedAt != nil {
		row.StartedAt = transferTime(*t.StartedAt)
	}
	if t.EndedAt != nil {
		row.EndedAt = transferTime(*t.EndedAt)
	}
	if p := t.Live; p != nil && t.EndedAt == nil {
		row.Progress = &transferProgress{
			Percent: p.Pct, Bytes: p.Bytes, TotalBytes: p.TotalBytes, BytesPerSecond: int64(p.Speed),
			ETASeconds: p.Eta, Files: p.Files, TotalFiles: p.TotalFiles, Errors: p.Errors,
		}
	}
	return row
}

// transferDetailOf returns a transfer in full, as get_transfer shows it: the row, its errors in
// English, its totals, and its files by outcome.
func (s *Server) transferDetailOf(ctx context.Context, d transfers.Detail) (transferDetail, error) {
	out := transferDetail{
		transferRow:    transferRowOf(d.Transfer),
		Error:          d.ErrorText().String(),
		RetryableParts: d.Retryable,
	}
	for _, g := range d.General {
		text := g.ErrorText().String()
		// The transfer's own error is often its one general error too.
		if g.Subject == "" && text == out.Error {
			continue
		}
		out.Errors = append(out.Errors, transferError{About: g.Subject, Error: text})
	}
	if d.RetryOf != nil {
		out.RetryOf = d.RetryOf.Seq
	}
	if st := d.Stats; st != nil {
		out.Totals = &transferTotals{
			Bytes: st.Bytes, FilesTransferred: st.Transfers, FilesChecked: st.Checks, Deleted: st.Deletes,
			Renamed: st.Renames, Errors: st.Errors, DurationSeconds: float64(st.DurationMs) / 1000,
		}
	}
	var err error
	if out.Changed, err = s.transferChanged(ctx, d.ID); err != nil {
		return transferDetail{}, err
	}
	if out.Failed, err = s.transferFilesOf(ctx, d.ID, transfers.OutcomeFailed, transferFailedShown); err != nil {
		return transferDetail{}, err
	}
	if out.Checked, err = s.transferFilesOf(ctx, d.ID, transfers.OutcomeChecked, transferCheckedShown); err != nil {
		return transferDetail{}, err
	}
	return out, nil
}

// transferFilesOf returns the newest files of a transfer with one outcome, at most limit of
// them.
func (s *Server) transferFilesOf(ctx context.Context, id string, outcome transfers.Outcome, limit int) (transferFiles, error) {
	page, err := s.o.APIs.Transfers.Files(ctx, id, outcome, "", limit)
	if err != nil {
		return transferFiles{}, err
	}
	out := transferFiles{Count: page.Total, Files: make([]transferFile, 0, len(page.Items)), Truncated: page.More}
	for _, f := range page.Items {
		out.Files = append(out.Files, transferFileOf(f))
	}
	return out, nil
}

// transferChanged returns the files that a transfer changed, or that its dry run would change.
// It reads as many as the record keeps, so that it can count them by action and list the
// deletions, which matter most to the user, before the copies.
func (s *Server) transferChanged(ctx context.Context, id string) (transferFiles, error) {
	var all []transferFile
	out := transferFiles{ByAction: map[string]int{}}
	for before := ""; len(all) < transferChangedRead; {
		page, err := s.o.APIs.Transfers.Files(ctx, id, transfers.OutcomeTransferred, before, transferFilesPage)
		if err != nil {
			return transferFiles{}, err
		}
		out.Count = page.Total
		for _, f := range page.Items {
			all = append(all, transferFileOf(f))
		}
		if !page.More || len(page.Items) == 0 {
			break
		}
		before = page.Items[len(page.Items)-1].Cursor
	}
	for _, f := range all {
		out.ByAction[f.Action]++
	}
	slices.SortStableFunc(all, func(a, b transferFile) int {
		return cmp.Or(cmp.Compare(transferActionRank(a.Action), transferActionRank(b.Action)), strings.Compare(a.Path, b.Path))
	})
	out.Files = all[:min(len(all), transferChangedShown)]
	out.Truncated = len(out.Files) < out.Count
	if out.Files == nil {
		out.Files = []transferFile{}
	}
	if len(out.ByAction) == 0 {
		out.ByAction = nil
	}
	return out, nil
}

// transferActionRank orders changed files for the agent: deletions first, then moves and
// renames, then anything else, and the copies last.
func transferActionRank(action string) int {
	switch action {
	case "delete":
		return 0
	case "move":
		return 1
	case "rename":
		return 2
	case "copy":
		return 4
	}
	return 3
}

// transferFileOf returns a file of a transfer as an agent reads it. Its path is in the folder
// that rclone names as its source. A deletion names none, so its path is the one inside the
// folder that the transfer deleted it from.
func transferFileOf(f transfers.File) transferFile {
	path := f.Name
	if f.SrcFs != "" {
		path = transferFilePath(f.SrcFs, f.Name)
	}
	return transferFile{Path: path, Action: transferFileAction(f.What), Size: f.Size, Error: f.Error}
}

// transferFilePath returns the path of the file called name in the folder that rclone names
// srcFs. The app opens a local folder as a remote of the local backend, so rclone names it
// ":local:/tmp/x". On Windows rclone uses the long form ("//?/C:/x", or "//?/UNC/server/share/x"
// for a share). Both are turned back into the plain local path, as the agent wrote it. Any other
// file is named by rclone's own join.
func transferFilePath(srcFs, name string) string {
	root, ok := strings.CutPrefix(srcFs, ":local:")
	if ok && runtime.GOOS == "windows" {
		if share, isShare := strings.CutPrefix(root, "//?/UNC/"); isShare {
			root = "//" + share
		} else {
			root = strings.TrimPrefix(root, "//?/")
		}
	}
	if !ok || !filepath.IsAbs(filepath.FromSlash(root)) {
		return fspath.JoinRootPath(srcFs, name)
	}
	return filepath.Join(filepath.FromSlash(root), filepath.FromSlash(name))
}

// transferFileAction returns what rclone did to a file (its "what") in plain words.
func transferFileAction(what string) string {
	switch what {
	case "transferring":
		return "copy"
	case "deleting":
		return "delete"
	case "moving":
		return "move"
	case "renaming":
		return "rename"
	case "checking", "hashing", "listing":
		return "check"
	case "merging":
		return "merge"
	}
	return what
}

// transferTemplateOf returns a template as list_templates shows it. Its options are left out,
// because they are rclone's own flags, which could hold a backend's secret.
func transferTemplateOf(t templates.Template) transferTemplate {
	out := transferTemplate{TemplateID: t.ID, Name: t.Name, Operations: []string{}, CanRunAs: []string{}}
	for _, tag := range t.Tags {
		out.Operations = append(out.Operations, string(tag))
		if t.Paths != nil && runsAsTransfer(tag) {
			out.CanRunAs = append(out.CanRunAs, string(tag))
		}
	}
	if t.Paths != nil {
		out.Sources, out.Destination = t.Paths.Sources, t.Paths.Destination
	}
	return out
}

// runsAsTransfer reports whether a template for op runs as a transfer. A mount's or a serve's
// template is only applied in its window.
func runsAsTransfer(op operations.Operation) bool {
	switch op {
	case operations.OperationCopy, operations.OperationMove, operations.OperationSync,
		operations.OperationBisync, operations.OperationDelete, operations.OperationPurge:
		return true
	}
	return false
}

// runSavedTemplate runs a saved template as one of its operations. History shows the run as the
// template's, as when the user runs it. The core can't start a template as a dry run, so a dry
// run starts the template's form like any other tool's transfer, and History shows it as the
// agent's.
func (s *Server) runSavedTemplate(ctx context.Context, in transferTemplateIn) (transferStarted, error) {
	list, err := s.o.APIs.Templates.List(ctx)
	if err != nil {
		return transferStarted{}, err
	}
	i := slices.IndexFunc(list.Templates, func(t templates.Template) bool { return t.ID == in.TemplateID })
	if i < 0 {
		return transferStarted{}, errs.New("No saved template has this id. list_templates lists them.")
	}
	t, op := list.Templates[i], operations.Operation(strings.ToLower(strings.TrimSpace(in.Operation)))
	if t.Paths == nil || !runsAsTransfer(op) || !slices.Contains(t.Tags, op) {
		return transferStarted{}, errs.New("This template can't run as that operation. Its can_run_as, in list_templates, lists the ones it can.")
	}
	_, skipped, err := operations.TemplateGroups(op, "", t.Options)
	if err != nil {
		return transferStarted{}, err
	}
	ignored := transferIgnored(skipped)
	if in.DryRun {
		f, err := operations.TemplateArgs(op, t.Paths.Sources, t.Paths.Destination, t.Options)
		if err != nil {
			return transferStarted{}, err
		}
		return s.startTransfer(ctx, f, true, ignored)
	}
	st, err := s.o.APIs.Transfers.StartTemplate(ctx, t.ID, op)
	if err != nil {
		return transferStarted{}, transferStartError(err)
	}
	return transferStarted{TransferID: st.ID, Number: st.Seq, IgnoredOptions: ignored}, nil
}
