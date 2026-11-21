package templates

import (
	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/operations"
)

// Template is a named set of options, offered to the operations named by its tags. It can also
// hold the paths that its operation runs on.
type Template struct {
	ID   string                 `json:"id"`
	Name string                 `json:"name"`
	Tags []operations.Operation `json:"tags"`
	// Options are flat rclone flags, keyed by the option's name.
	Options catalog.Group `json:"options"`
	// Paths is nil when the template has no paths.
	Paths *Paths `json:"paths"`
}

// Paths are the paths that a template's operation runs on. A template for a sync, a bisync, a
// mount or a serve has at most one source, because each of them takes one (Check).
type Paths struct {
	Sources     []string `json:"sources"`
	Destination string   `json:"destination"`
}

// List holds every template, and every tag that a template can have.
type List struct {
	Templates []Template             `json:"templates"`
	Tags      []operations.Operation `json:"tags"`
}

// Applied is a template's options sorted into the groups of an operation's form, as its page
// applies them (operations.TemplateGroups). Skipped lists the options that the form leaves out,
// each with the reason.
type Applied struct {
	Groups  operations.Groups     `json:"groups"`
	Skipped []catalog.SkippedFlag `json:"skipped"`
}

// exported is a template as an export file holds it: its name, options and paths, and its options
// as rclone's flags (operations.TemplateFlags).
type exported struct {
	Name    string        `json:"name"`
	Options catalog.Group `json:"options"`
	Paths   *Paths        `json:"paths,omitempty"`
	Command string        `json:"command"`
}
