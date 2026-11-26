//go:build !production

package app

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/app/interaction"
	"github.com/rclone/rclone-ui/app/windows"
)

const production = false

func (u *ui) devServices() []application.Service {
	return []application.Service{service(u, &DevService{})}
}

func testFeed() string { return os.Getenv("RCUI_UPDATE_FEED") }

type DevService struct{}

var scriptedAnswer func(title, message string, prompt bool) (string, bool)

// Scripted returns the answer that the script gives to a page's dialog: ok, cancel, extra or
// text:<value>. It returns nil when no script answers, and the page then waits for the user.
func (s *DevService) Scripted(title, message string, prompt bool) *string {
	if scriptedAnswer == nil {
		return nil
	}
	if answer, ok := scriptedAnswer(title, message, prompt); ok {
		return &answer
	}
	return nil
}

func (u *ui) devEval() {
	if d := os.Getenv("RCUI_DEV_LAUNCHER"); d != "" {
		u.launcher.DevScript(d)
	}
	dir := os.Getenv("RCUI_DEV_EVAL")
	if dir == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		u.log.Error("dev eval", "error", err)
		return
	}
	var mu sync.Mutex
	next := func(title, message string, prompt bool) string {
		mu.Lock()
		defer mu.Unlock()
		answer := ""
		path := filepath.Join(dir, "answers")
		if b, err := os.ReadFile(path); err == nil {
			lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
			if len(lines) > 0 && lines[0] != "" {
				answer = lines[0]
				_ = os.WriteFile(path, []byte(strings.Join(lines[1:], "\n")), 0o600)
			}
		}
		u.log.Info("dev eval: dialog", "title", title, "message", message, "prompt", prompt, "answer", answer)
		return answer
	}
	scriptedAnswer = func(title, message string, prompt bool) (string, bool) {
		answer := next(title, message, prompt)
		return answer, answer != ""
	}
	interaction.Scripted = func(d interaction.Dialog, prompt bool) (interaction.Answer, string) {
		answer := next(d.Title, d.Message, prompt)
		switch {
		case strings.HasPrefix(answer, "text:"):
			return interaction.AnswerOK, strings.TrimPrefix(answer, "text:")
		case answer == "ok":
			return interaction.AnswerOK, ""
		case answer == "extra":
			return interaction.AnswerExtra, ""
		}
		return interaction.AnswerCancel, ""
	}
	go func() {
		for range time.Tick(300 * time.Millisecond) {
			files, _ := filepath.Glob(filepath.Join(dir, "*.js"))
			for _, f := range files {
				code, err := os.ReadFile(f)
				_ = os.Remove(f)
				if err != nil {
					continue
				}
				name, _ := windows.ForRoute(u.opts.open)
				if base := strings.TrimSuffix(filepath.Base(f), ".js"); strings.Contains(base, ".") {
					name = base[:strings.Index(base, ".")]
				}
				w, ok := u.windows.Get(name)
				if !ok {
					u.log.Warn("dev eval: no such window", "window", name)
					continue
				}
				w.ExecJS("(async () => { try { " + string(code) + " } catch (e) { console.error('[eval]', String(e && e.stack || e)) } })()")
			}
		}
	}()
}
