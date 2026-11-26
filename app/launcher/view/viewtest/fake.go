package viewtest

import "github.com/rclone/rclone-ui/app/launcher/view"

type Fake struct {
	Events   view.Events
	Shown    bool
	At       *view.Placement
	Last     view.Snapshot
	Renders  int
	Query    string
	Selected bool
}

func (f *Fake) Show(at *view.Placement) { f.Shown, f.At = true, at }

func (f *Fake) Hide() { f.Shown = false }

func (f *Fake) Render(s view.Snapshot) { f.Last, f.Renders = s, f.Renders+1 }

func (f *Fake) SetQuery(text string, selectAll bool) { f.Query, f.Selected = text, selectAll }

func (f *Fake) Visible() bool { return f.Shown }

func (f *Fake) Type(text string) {
	f.Query = text
	if f.Events.Query != nil {
		f.Events.Query(text)
	}
}

func (f *Fake) Press(k view.KeyEvent) bool {
	if f.Events.Key == nil {
		return false
	}
	return f.Events.Key(k)
}

func (f *Fake) Titles() []string {
	t := make([]string, len(f.Last.Rows))
	for i, r := range f.Last.Rows {
		t[i] = r.Title
	}
	return t
}
