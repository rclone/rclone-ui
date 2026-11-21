package transfers

import (
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/late"
)

// TestSavedErrors checks that the core's own error is saved with its message and values, that
// the service reads it in English, that the API gives it in the app's language, and that History's
// search finds it in either. rclone's own error is saved as its words.
func TestSavedErrors(t *testing.T) {
	f := newFixture(t)
	// i18n.M builds the message as resumeRefused saves it.
	own := i18n.M("Couldn't start again after the update: %v", "no such remote")
	f.seed("100-a", 100, map[string]any{"state": "failed", "error": i18n.SaveText(own)})
	f.seed("101-b", 101, map[string]any{"state": "failed", "error": "directory not found"})
	const english = "Couldn't start again after the update: no such remote"

	if tr := f.get("100-a"); tr.Error != english || tr.ErrorText().String() != english {
		t.Fatalf("the service reads %q", tr.Error)
	}
	if tr := f.get("101-b"); tr.Error != "directory not found" {
		t.Fatalf("rclone's error reads %q", tr.Error)
	}
	api := NewAPI(late.Of(f.s), late.Of[Templates](templatesOf{}))
	errorsOf := func(search string) map[string]string {
		t.Helper()
		page, err := api.ListEnded(f.ctx, EndedQuery{Search: search})
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for _, tr := range page.Items {
			out[tr.ID] = tr.Error
		}
		return out
	}
	if got := errorsOf(""); got["100-a"] != english || got["101-b"] != "directory not found" {
		t.Fatalf("the API lists %v", got)
	}
	if got := errorsOf("start again"); len(got) != 1 || got["100-a"] == "" {
		t.Fatalf("a search for the English words finds %v", got)
	}

	i18n.SetLanguage(i18n.Pseudo)
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	got := errorsOf("")
	if shown := got["100-a"]; !strings.HasPrefix(shown, "[") || !strings.Contains(shown, "no such remote") {
		t.Errorf("the API shows %q in the pseudo-language", shown)
	}
	// The pseudo-language brackets every text, including rclone's words, which it leaves as they are.
	if !strings.Contains(got["101-b"], "directory not found") {
		t.Errorf("rclone's error is shown as %q, want its own words", got["101-b"])
	}
	shown := strings.Trim(got["100-a"], "[]")
	words := strings.Fields(shown)
	if found := errorsOf(words[0]); len(found) != 1 || found["100-a"] == "" {
		t.Errorf("a search for %q, as the page shows it, finds %v", words[0], found)
	}
	if found := errorsOf("start again"); len(found) != 1 {
		t.Errorf("a search in English finds %v in another language", found)
	}
	d, err := api.Get(f.ctx, "100-a")
	if err != nil || d.Error != got["100-a"] || len(d.General) != 1 || d.General[0].Error != got["100-a"] {
		t.Fatalf("Get = %+v, %v", d, err)
	}
	// The agents' server reads the errors in English, whatever the app's language.
	if d.ErrorText().String() != english || d.General[0].ErrorText().String() != english {
		t.Errorf("in English: %q and %q", d.ErrorText().String(), d.General[0].ErrorText().String())
	}
}

// TestSummaryIsSaved checks that a batch's summary of failed steps is saved as a translatable
// message, which reads back in English.
func TestSummaryIsSaved(t *testing.T) {
	out := outcome{V: 1, Errors: []string{"", i18n.Save(errString("object not found")), ""}}
	_, text := stateOf(i18n.Text{}, out)
	saved := i18n.SaveText(text)
	if saved == text.String() || i18n.Saved(saved).String() != "1 of 3 operations failed" {
		t.Errorf("saved %q", saved)
	}
	// rclone's own error is saved as its words.
	if got := saveText(words("directory not found")); got != "directory not found" {
		t.Errorf("rclone's error saved as %q", got)
	}
	if got := saveText(i18n.Text{}); got != "" {
		t.Errorf("no error saved as %q", got)
	}
}

// TestSearchByName checks that History's search finds a transfer by its operation's name, in
// English and in the app's language.
func TestSearchByName(t *testing.T) {
	sync := Transfer{Seq: 1, Operation: "sync", Sources: []string{"/a"}, Destination: "/b"}
	purge := Transfer{Seq: 2, Operation: "purge", Sources: []string{"/a"}}
	if !Matches(sync, "Sync") || Matches(purge, "Sync") || !Matches(purge, "purge") {
		t.Error("an English name")
	}
	if !Matches(Transfer{Operation: "delete-folder"}, "delete folder") {
		t.Error("a name of two words")
	}

	i18n.SetLanguage("es")
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	name := OperationName("sync")
	if name == "Sync" {
		t.Skip("the Spanish catalog has no translation of Sync yet (npm run i18n)")
	}
	if !Matches(sync, name) || !Matches(sync, strings.ToUpper(name)) || Matches(purge, name) {
		t.Errorf("the Spanish name %q", name)
	}
	if !Matches(sync, "sync") || !Matches(sync, "Sync") {
		t.Error("the key and the English name, in Spanish")
	}
}

type errString string

func (e errString) Error() string { return string(e) }
