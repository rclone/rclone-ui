//go:build !production

package launcher

import (
	"fmt"
	"strings"

	"github.com/rclone/rclone-ui/app/launcher/view"
)

// Development scripting (RCUI_DEV_LAUNCHER): these functions drive the launcher the way its view
// would, without a keyboard. Like the rest of the launcher, they run on the main thread.

// DevType replaces the text, as typing would.
func (l *Launcher) DevType(text string) {
	if l.view != nil {
		l.view.SetQuery(text, false)
	}
	l.onQuery(text)
}

func (l *Launcher) DevKey(k view.KeyEvent) bool { return l.onKey(k) }

func (l *Launcher) DevHover(row int) { l.onHover(row) }

func (l *Launcher) DevClick(row int) { l.onClick(row) }

func (l *Launcher) DevDrop(paths []string) { l.onDrop(paths) }

// DevState describes what the launcher shows: its text, the rows drawn and the selection.
func (l *Launcher) DevState() string {
	var b strings.Builder
	fmt.Fprintf(&b, "visible=%v text=%q busy=%v", l.Visible(), l.text, l.busy)
	if l.status.Kind != view.StatusNone {
		fmt.Fprintf(&b, " status=%q", l.status.Text)
	}
	if len(l.dropped) > 0 {
		fmt.Fprintf(&b, " header=%q", droppedHeader(l.dropped))
	}
	if l.panel != nil {
		fmt.Fprintf(&b, " panel=%q", l.panel.result.Title)
		if l.panel.question != "" {
			fmt.Fprintf(&b, " question=%q", l.panel.question)
		}
		for i, a := range l.panel.actions {
			mark := " "
			if i == l.panel.sel {
				mark = ">"
			}
			fmt.Fprintf(&b, "\n %s %s", mark, a.Name)
		}
		return b.String()
	}
	end := drawnEnd(l.spans(), l.off)
	for i := l.off; i < end; i++ {
		r := l.results[i]
		if startsGroup(l.results, i) {
			fmt.Fprintf(&b, "\n   [%s]", r.Group)
		}
		mark := " "
		if i == l.sel {
			mark = ">"
		}
		fmt.Fprintf(&b, "\n %s %-3s %s", mark, l.rowHint(i), r.Title)
		if r.Tail != "" {
			fmt.Fprintf(&b, "  [%s]", r.Tail)
		}
	}
	if len(l.results) > end {
		fmt.Fprintf(&b, "\n   … %d more", len(l.results)-end)
	}
	return b.String()
}
