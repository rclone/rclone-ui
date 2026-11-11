package config

import (
	"context"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/errs"
)

func TestCheckText(t *testing.T) {
	for _, text := range []string{
		"",
		"\n  \n",
		"# only\n; comments\n",
		"\uFEFF[work]\ntype = alias\nremote = /tmp\n",
		"[my drive]\ntype = drive\ntoken = {\"a\":\"b\"}\n\n[1]\ntype = local\n",
		"[é]\ntype = local\n",
		"[a1]\n`quoted key` = v\n\"double\" = v\n\"\"\"triple\"\"\" = v\nk = `quoted value`\nk2 = \"\"\"triple value\"\"\"\nk3:v\nempty =\n",
	} {
		if err := CheckText(text); err != nil {
			t.Errorf("CheckText(%q) = %v, want no error", text, err)
		}
	}
	for _, tc := range []struct{ text, want string }{
		{"token = s3cr3t\n[a1]\n", "line 1: a key before the first [section]"},
		{"[a1]\nk = v\n[ ]\n", "line 3: a section needs a name"},
		{"[a1]\nk = v\njust s3cr3t words\n", "line 3: expected [section] or key = value"},
		{"[a1]\n= s3cr3t\n", "line 2: expected [section] or key = value"},
		{"[a1]\n`unclosed = s3cr3t\n", "line 2: expected [section] or key = value"},
		{"[a1]\nk = `s3cr3t\n", "line 2: expected [section] or key = value"},
		{"[a1]\nk = s3\x00cr3t\n", "line 2: it holds a NUL character, which a config can't hold"},
		{"[x]\ntype = local\n", "line 1: [x]: A name can't be a single letter: on Windows that is a drive."},
		{"[ok]\n[-bad]\n", "line 2: [-bad]: A name may contain letters, digits, spaces and _ - . + @, and cannot start with - or a space, or end with one."},
	} {
		err := CheckText(tc.text)
		if err == nil || err.Error() != tc.want {
			t.Errorf("CheckText(%q) = %v, want %q", tc.text, err, tc.want)
			continue
		}
		if errs.FieldOf(err) != "text" {
			t.Errorf("CheckText(%q): the error is on %q, want text", tc.text, errs.FieldOf(err))
		}
		if strings.Contains(err.Error(), "s3cr3t") {
			t.Errorf("the error quotes the line: %v", err)
		}
	}
}

// WriteText refuses text that CheckText refuses, and leaves the file as it was.
func TestWriteTextChecks(t *testing.T) {
	ctx := context.Background()
	s := newService(t, writeConfig(t, "[aa]\ntype = memory\n", ""), nil)
	start(t, s)
	if err := s.WriteText(ctx, "[ok]\ntype = memory\n"); err != nil {
		t.Fatal(err)
	}
	err := s.WriteText(ctx, "[ok]\ntype = memory\n[ ]\n")
	if errs.FieldOf(err) != "text" || err.Error() != "line 3: a section needs a name" {
		t.Errorf("= %v, want the line error on text", err)
	}
	if text, err := s.ReadText(ctx); err != nil || text != "[ok]\ntype = memory\n" {
		t.Errorf("the file reads %q %v", text, err)
	}
	if err := s.WriteText(ctx, ""); err != nil {
		t.Errorf("an empty config: %v", err)
	}
}
