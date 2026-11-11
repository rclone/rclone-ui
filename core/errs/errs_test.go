package errs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"testing"

	"github.com/rclone/rclone-ui/core/i18n"
)

func TestTextAndIdentity(t *testing.T) {
	a, b := New("No such thing."), New("No such thing.")
	wrapped := Errorf("The file is gone: %w", fs.ErrNotExist)
	for _, c := range []struct {
		name string
		got  bool
	}{
		{"New says its text", a.Error() == "No such thing."},
		{"Errorf formats", wrapped.Error() == "The file is gone: file does not exist"},
		{"an error is itself", errors.Is(a, a)},
		{"two errors with one text are two errors", !errors.Is(a, b)},
		{"a %w operand is reachable", errors.Is(wrapped, fs.ErrNotExist)},
		{"a wrapped sentence is found", errors.Is(Errorf("again: %w", a), a)},
	} {
		if !c.got {
			t.Error(c.name)
		}
	}
}

func TestField(t *testing.T) {
	err := Field("name", "Enter a name.")
	wrapped := fmt.Errorf("saving: %w", err)
	for _, c := range []struct {
		name string
		got  bool
	}{
		{"it says its message", err.Error() == "Enter a name."},
		{"it is said as it is", Is(err) && Is(wrapped)},
		{"its field is found through a wrap", FieldOf(wrapped) == "name"},
		{"a sentence refuses no field", FieldOf(New("No.")) == "" && FieldOf(errors.New("x")) == ""},
	} {
		if !c.got {
			t.Error(c.name)
		}
	}
}

// TestOf checks how Of converts the core's own errors for the pages. A refusal becomes Invalid,
// with its text unchanged and the rejected field. A canceled request becomes Canceled. Any other
// error is left to rclone.ErrorOf.
func TestOf(t *testing.T) {
	e := Of(fmt.Errorf("renaming: %w", Field("name", "That name is taken.")))
	if e.Code != CodeInvalid || e.Message != "renaming: That name is taken." ||
		len(e.Fields) != 1 || e.Fields[0].Field != "name" || e.Fields[0].Description != "That name is taken." {
		t.Errorf("a field's refusal: %+v", e)
	}
	if e := Of(New("Nothing to rename.")); e.Code != CodeInvalid || e.Message != "Nothing to rename." || len(e.Fields) != 0 {
		t.Errorf("a form's refusal: %+v", e)
	}
	if e := Of(fmt.Errorf("listing: %w", context.Canceled)); e.Code != CodeCanceled {
		t.Errorf("a cancelled request: %+v", e)
	}
	if e := Of(errors.New("directory not found")); e != nil {
		t.Errorf("rclone's failure: %+v", e)
	}
	nf := NotFound("remote", `no remote named "gdrive"`)
	if e := Of(fmt.Errorf("opening: %w", nf)); e != nf {
		t.Errorf("an error made here, wrapped: %+v", e)
	}
}

// TestMarshal checks the JSON that the pages read: the code, the message, and the details that
// the page acts on.
func TestMarshal(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{Field("name", "Enter a name."), `{"code":"invalid","message":"Enter a name.","fields":[{"field":"name","description":"Enter a name."}]}`},
		{Reconnect("gdrive", errors.New("token expired")), `{"code":"reconnect","message":"token expired","remote":"gdrive"}`},
		{Launched(errors.New("refused"), "t1", 7), `{"code":"failed","message":"refused","transfer":{"id":"t1","seq":7}}`},
	} {
		raw, err := json.Marshal(Of(c.err))
		if err != nil {
			t.Fatal(err)
		}
		got := string(raw)
		var a, b any
		if json.Unmarshal([]byte(got), &a) != nil || json.Unmarshal([]byte(c.want), &b) != nil || fmt.Sprint(a) != fmt.Sprint(b) {
			t.Errorf("%v: %s, want %s", c.err, got, c.want)
		}
	}
}

// TestTextRefusals checks the refusals made from a text: a sentence, and a field's refusal. Each
// reads in English, and Of turns it into Invalid with its field.
func TestTextRefusals(t *testing.T) {
	text := i18n.MN("%d name is taken.", "%d names are taken.", 2, 2)
	if e := Of(Sentence(text)); e.Code != CodeInvalid || e.Message != "2 names are taken." {
		t.Errorf("a sentence: %+v", e)
	}
	e := Of(FieldText("items", text))
	if e.Code != CodeInvalid || len(e.Fields) != 1 || e.Fields[0].Field != "items" || e.Fields[0].Description != "2 names are taken." {
		t.Errorf("a field's refusal: %+v", e)
	}
}
