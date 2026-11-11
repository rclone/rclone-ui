//go:build !production

package host

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/app/launcher/view"
)

// DevScript runs launcher scripts that are dropped in dir (RCUI_DEV_LAUNCHER). A script is a file
// named <anything>.cmd with one command per line. It runs once and is then removed. The commands
// are: show, hide, type <text>, key <up|down|enter|esc|tab|actions|row:<char>>, hover <row>,
// click <row>, drop <path>… (paths without spaces), sleep <duration>, and state (which is logged).
// Only a development build has it.
func (h *Host) DevScript(dir string) {
	log := h.o.Log
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Error("dev launcher", "error", err)
		return
	}
	keys := map[string]view.Key{"up": view.KeyUp, "down": view.KeyDown, "enter": view.KeyEnter,
		"esc": view.KeyEsc, "tab": view.KeyTab, "actions": view.KeyActions}
	go func() {
		for range time.Tick(200 * time.Millisecond) {
			files, _ := filepath.Glob(filepath.Join(dir, "*.cmd"))
			sort.Strings(files)
			for _, f := range files {
				data, err := os.ReadFile(f)
				_ = os.Remove(f)
				if err != nil {
					continue
				}
				sc := bufio.NewScanner(strings.NewReader(string(data)))
				for sc.Scan() {
					line := strings.TrimSpace(sc.Text())
					if line == "" || strings.HasPrefix(line, "#") {
						continue
					}
					verb, arg, _ := strings.Cut(line, " ")
					switch verb {
					case "show":
						application.InvokeSync(h.l.Show)
					case "hide":
						application.InvokeSync(h.l.Hide)
					case "type":
						application.InvokeSync(func() { h.l.DevType(arg) })
					case "key":
						k := view.KeyEvent{Key: keys[arg]}
						if c, ok := strings.CutPrefix(arg, "row:"); ok && c != "" {
							k = view.KeyEvent{Key: view.KeyRow, Char: []rune(c)[0]}
						}
						application.InvokeSync(func() { h.l.DevKey(k) })
					case "hover", "click":
						row, _ := strconv.Atoi(arg)
						application.InvokeSync(func() {
							if verb == "hover" {
								h.l.DevHover(row)
							} else {
								h.l.DevClick(row)
							}
						})
					case "drop":
						paths := strings.Fields(arg)
						application.InvokeSync(func() { h.l.DevDrop(paths) })
					case "sleep":
						d, _ := time.ParseDuration(arg)
						time.Sleep(d)
					case "state":
						var s string
						application.InvokeSync(func() { s = h.l.DevState() })
						log.Info("dev launcher: state\n" + s)
					default:
						log.Warn("dev launcher: unknown command", "line", line)
					}
				}
			}
		}
	}()
}
