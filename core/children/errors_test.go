package children

import (
	"errors"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/i18n"
)

// TestTextError checks that why a child went down is shown in the app's language, also when it
// quotes another error, and that the quoted error can still be found.
func TestTextError(t *testing.T) {
	cause := errors.New("exit status 1")
	err := TextError(i18n.M("%s exited before it was ready: %w", "/mnt/x", cause), cause)
	if err.Error() != "/mnt/x exited before it was ready: exit status 1" || !errors.Is(err, cause) {
		t.Fatalf("got %q", err)
	}
	if i18n.Localize(err) != err.Error() {
		t.Errorf("in English: %q", i18n.Localize(err))
	}
	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	if got := i18n.Localize(err); !strings.HasPrefix(got, "[") || !strings.Contains(got, "exit status 1") {
		t.Errorf("in the pseudo-language: %q", got)
	}
	// rclone's own line keeps its words.
	if got := i18n.Localize(clipped(errors.New("ERROR the token expired"))); got != "ERROR the token expired" {
		t.Errorf("rclone's line: %q", got)
	}
}
