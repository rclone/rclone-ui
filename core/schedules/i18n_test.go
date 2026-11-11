package schedules

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/internal/testutil"
)

// TestLastErrorIsSaved checks that a run's error is saved with its message and values, that the
// service reads it in English, and that the API gives it in the app's language.
func TestLastErrorIsSaved(t *testing.T) {
	r := &fakeRunner{refuse: []error{errs.Errorf("couldn't find remote %q", "gone")}}
	f := newFixture(t, r)
	f.boot()
	sc := daily(f, "Photos")
	testutil.Must(t, f.s.RunNow(context.Background(), sc.ID))
	f.goes.Wait()

	const english = `couldn't find remote "gone"`
	var saved string
	testutil.Must(t, f.db.Read(context.Background(), func(tx *sql.Tx) error {
		return tx.QueryRow(`SELECT last_error FROM schedules WHERE id = ?`, sc.ID).Scan(&saved)
	}))
	if saved == english || i18n.Saved(saved).String() != english {
		t.Fatalf("saved %q, want the error's saved form", saved)
	}
	if got := f.get(sc.ID); got.LastError != english {
		t.Fatalf("the service reads %q", got.LastError)
	}
	api := NewAPI(late.Of(f.s))
	if got, err := api.Get(context.Background(), sc.ID); err != nil || got.LastError != english {
		t.Fatalf("the API gives %q, %v", got.LastError, err)
	}

	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	list, err := api.List(context.Background())
	if err != nil || len(list) != 1 || !strings.HasPrefix(list[0].LastError, "[") || !strings.Contains(list[0].LastError, `"gone"`) {
		t.Fatalf("the API lists %+v in the pseudo-language, %v", list, err)
	}
	if names, err := api.LeftOff(context.Background(), sc.Form); err != nil || len(names) != 0 {
		t.Errorf("left off %v, %v", names, err)
	}
}

// TestBisyncErrorIsTranslatable checks that the scheduler's own wording of a bisync's trouble is
// a translatable message with the folder in it, and that other errors are kept as they are.
func TestBisyncErrorIsTranslatable(t *testing.T) {
	deletes := i18n.Saved("too many deletes on Path2 - 60% > 50%")
	got := bisyncError(deletes, "/a", "/b")
	saved := i18n.SaveText(got)
	if !strings.HasPrefix(i18n.Saved(saved).String(), "Many files were deleted in ") || saved == got.String() {
		t.Errorf("a bisync's trouble: %q saved as %q", got.String(), saved)
	}
	if other := i18n.Saved("couldn't connect"); bisyncError(other, "/a", "/b").String() != "couldn't connect" {
		t.Error("another error was reworded")
	}
}
