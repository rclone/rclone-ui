package notifications

import (
	"encoding/json"
	"strings"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/logs"
)

// Payload is the content of one event. Message returns the title and body that every provider
// shows. The value itself, as JSON, is the data sent to generic webhooks.
type Payload interface {
	Message(event NotificationEvent) (title, body string)
}

// redacted returns p with any credentials in its remotes and errors hidden, the same way the logs
// hide them (logs.Redact). This matters because a payload leaves the machine, for a chat service
// or a webhook's owner.
func redacted(p Payload) Payload {
	switch v := p.(type) {
	case Job:
		if v.Sources != nil {
			sources := make([]string, len(v.Sources))
			for i, src := range v.Sources {
				sources[i] = logs.Redact(src)
			}
			v.Sources = sources
		}
		v.Destination, v.Error = logs.Redact(v.Destination), logs.Redact(v.Error)
		return v
	case MountFailed:
		v.Source, v.Destination = logs.Redact(v.Source), logs.Redact(v.Destination)
		v.Error, v.Reason = logs.Redact(v.Error), logs.Redact(v.Reason)
		return v
	case ServeFailed:
		v.Source, v.Error = logs.Redact(v.Source), logs.Redact(v.Error)
		return v
	case WatcherFailed:
		v.PathA, v.PathB, v.Error = logs.Redact(v.PathA), logs.Redact(v.PathB), logs.Redact(v.Error)
		return v
	case Crashed:
		v.Error = logs.Redact(v.Error)
		return v
	}
	return p
}

// Job is the payload of job.started, job.completed and job.failed.
type Job struct {
	// JobID is the transfer's seq, which is the number that the pages show.
	JobID       int64
	Operation   string
	Sources     []string
	Destination string // "" for none, sent as null
	// DurationSeconds is set when the job ends (completed or failed).
	DurationSeconds *int64
	Error           string // set for job.failed
	// Schedule is the name of the schedule that ran the job, or "" when the user ran it.
	Schedule string
}

// MarshalJSON writes a job as generic webhooks receive it: the id as `jobid`, the sources never
// null, and a null destination when there is none.
func (j Job) MarshalJSON() ([]byte, error) {
	var dest *string
	if j.Destination != "" {
		dest = &j.Destination
	}
	sources := j.Sources
	if sources == nil {
		sources = []string{}
	}
	return json.Marshal(struct {
		JobID           int64    `json:"jobid"`
		Operation       string   `json:"operation"`
		Sources         []string `json:"sources"`
		Destination     *string  `json:"destination"`
		DurationSeconds *int64   `json:"durationSeconds,omitempty"`
		Error           string   `json:"error,omitempty"`
		Schedule        string   `json:"schedule,omitempty"`
	}{j.JobID, j.Operation, sources, dest, j.DurationSeconds, j.Error, j.Schedule})
}

// Message returns the event's label as the title, and a body that describes what ran ("copy of
// a:x, b:y and 2 more to c:z"), in the app's language.
func (j Job) Message(event NotificationEvent) (string, string) {
	meta, _ := lookup(event)
	body := jobBody(j.Operation, sourcesText(j.Sources), j.Destination)
	if event == NotificationEventJobFailed && j.Error != "" {
		// i18n: A failed transfer's notification: what ran, and the error it failed with.
		body = i18n.T("%s — %s", body, j.Error)
	}
	if j.Schedule != "" {
		// i18n: A notification about a schedule's run: the schedule's name, and what ran.
		body = i18n.T("%s: %s", j.Schedule, body)
	}
	return meta.Label, body
}

// sourcesText lists a job's sources: all of them up to two, or the first two and how many more.
func sourcesText(sources []string) string {
	if len(sources) <= 2 {
		return strings.Join(sources, ", ")
	}
	n := len(sources) - 2
	// i18n: A transfer's sources in a notification: the first two, then how many more there are.
	return i18n.N("%s and %d more", "%s and %d more", n, strings.Join(sources[:2], ", "), n)
}

// jobBody describes what a job ran: its operation, from source to destination. Either may be "".
func jobBody(operation, source, destination string) string {
	switch {
	case source != "" && destination != "":
		return jobFromTo(operation, source, destination)
	case source != "":
		return jobFrom(operation, source)
	case destination != "":
		// i18n: A transfer in a notification, when only its destination is known. The first value is the operation, as rclone names it (copy, sync).
		return i18n.T("%s to %s", operation, destination)
	}
	return operation
}

// jobFromTo describes a job with its sources and its destination, as in "copy of a:x to b:y".
func jobFromTo(operation, source, destination string) string {
	switch operation {
	case "copy":
		return i18n.T("copy of %s to %s", source, destination)
	case "move":
		return i18n.T("move of %s to %s", source, destination)
	case "sync":
		return i18n.T("sync of %s to %s", source, destination)
	case "bisync":
		return i18n.T("bisync of %s to %s", source, destination)
	case "download":
		return i18n.T("download of %s to %s", source, destination)
	}
	// i18n: A transfer in a notification. The first value is the operation, as rclone names it.
	return i18n.T("%s of %s to %s", operation, source, destination)
}

// jobFrom describes a job without a destination, as in "delete of a:x".
func jobFrom(operation, source string) string {
	switch operation {
	case "delete":
		// i18n: A transfer in a notification: what was deleted.
		return i18n.T("delete of %s", source)
	case "purge":
		// i18n: A transfer in a notification: the folder that was purged (deleted with all it holds).
		return i18n.T("purge of %s", source)
	case "cleanup":
		// i18n: A transfer in a notification: the remote whose trash was cleaned up.
		return i18n.T("cleanup of %s", source)
	case "copy":
		return i18n.T("copy of %s", source)
	case "move":
		return i18n.T("move of %s", source)
	case "sync":
		return i18n.T("sync of %s", source)
	}
	// i18n: A transfer in a notification. The first value is the operation, as rclone names it.
	return i18n.T("%s of %s", operation, source)
}

// MountFailed is the payload of mount.failed, sent when a mount could not start, crashed, or was
// skipped at startup.
type MountFailed struct {
	Source      string `json:"source"`
	Destination string `json:"destination"` // the mount point
	Error       string `json:"error"`
	// Skipped is true when an automount found the source unreachable and didn't mount it.
	// Mounting would show an empty folder at the mount point, which would look like lost files.
	Skipped bool `json:"-"`
	// Reason explains what is wrong with a skipped source (missing, or a file). It is "" when the
	// source didn't respond.
	Reason string `json:"-"`
}

func (m MountFailed) Message(NotificationEvent) (string, string) {
	if m.Skipped {
		if m.Reason != "" {
			return i18n.T("Automount skipped"), m.Reason
		}
		// i18n: The values are an automount's source and its mount point.
		return i18n.T("Automount skipped"), i18n.T("%s is not reachable (network or sign-in problem) — not mounting to avoid an empty folder at %s", m.Source, m.Destination)
	}
	// i18n: The values are a mount's source and the error.
	return i18n.T("Mount failed"), i18n.T("Failed to mount %s: %s", m.Source, m.Error)
}

// ServeFailed is the payload of serve.failed, sent when a serve could not start or stopped.
type ServeFailed struct {
	Type   string `json:"type"`
	Addr   string `json:"addr"`
	Source string `json:"source"`
	Error  string `json:"error"`
}

func (s ServeFailed) Message(NotificationEvent) (string, string) {
	// i18n: The values are what is served, the protocol (webdav, http), the address and the error.
	return i18n.T("Serve failed"), i18n.T("Failed to serve %s over %s on %s: %s", s.Source, s.Type, s.Addr, s.Error)
}

// WatcherFailed is the payload of watcher.failed, sent when a watcher's sync fails for the first
// time after it last succeeded.
type WatcherFailed struct {
	Name  string `json:"name"`
	PathA string `json:"pathA"`
	PathB string `json:"pathB"`
	Error string `json:"error"`
}

func (w WatcherFailed) Message(NotificationEvent) (string, string) {
	line, _, _ := strings.Cut(strings.TrimSpace(w.Error), "\n")
	// i18n: A watcher's failure: its name, and the error.
	return i18n.T("Watcher failed"), i18n.T("%s: %s", w.Name, strings.TrimSpace(line))
}

// Crashed is the payload of app.crashed, sent when the app's previous run stopped
// unexpectedly.
type Crashed struct {
	// Crashes is how many runs in a row stopped unexpectedly.
	Crashes int    `json:"crashes"`
	Error   string `json:"error,omitempty"`
}

func (c Crashed) Message(NotificationEvent) (string, string) {
	title := i18n.T("Rclone UI crashed")
	switch {
	case c.Crashes > 1 && c.Error != "":
		// i18n: The last value is the error that the app's previous run ended with.
		return title, i18n.N("Rclone UI quit unexpectedly %d time in a row and was started again. %s",
			"Rclone UI quit unexpectedly %d times in a row and was started again. %s", c.Crashes, c.Crashes, c.Error)
	case c.Crashes > 1:
		return title, i18n.N("Rclone UI quit unexpectedly %d time in a row and was started again.",
			"Rclone UI quit unexpectedly %d times in a row and was started again.", c.Crashes, c.Crashes)
	case c.Error != "":
		// i18n: The value is the error that the app's previous run ended with.
		return title, i18n.T("Rclone UI quit unexpectedly and was started again. %s", c.Error)
	}
	return title, i18n.T("Rclone UI quit unexpectedly and was started again.")
}

// UpdateAvailable is the payload of app.update-available.
type UpdateAvailable struct {
	Version string `json:"version"`
	Current string `json:"current"`
	Notes   string `json:"notes,omitempty"`
}

func (u UpdateAvailable) Message(NotificationEvent) (string, string) {
	// i18n: The values are the new version and the version that runs now.
	return i18n.T("Update available"), i18n.T("Rclone UI %s is available (this is %s).", u.Version, u.Current)
}

// testMessage returns the title and body of a test send, in the app's language. The body names
// the target if it has a name.
func testMessage(name string) (string, string) {
	title := testEvent.label.Local()
	if name = strings.TrimSpace(name); name != "" {
		// i18n: The value is the name of the notification target that the test goes to.
		return title, i18n.T("This is a test notification from Rclone UI for \"%s\".", name)
	}
	return title, i18n.T("This is a test notification from Rclone UI.")
}
