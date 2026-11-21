package main

import "testing"

func TestICUPlaceholders(t *testing.T) {
	for msg, want := range map[string]string{
		"Delete {name}?": "{name}",
		"{count, plural, one {# file} other {# files}}":                 "{count}",
		"{0, plural, one {Yes, with # rule} other {Yes, with # rules}}": "{0}",
		"Press <0>{key}</0> to start":                                   "<0> {key}",
		"{n, selectordinal, one {#st} other {#th}} of {month}":          "{month} {n}",
		"Nothing to fill in":                                            "",
		"{n, plural, one {Keep} other {Keep them}} or {other}":          "{n} {other}",
		"{n, plural, =0 {None} other {# left}}":                         "{n}",
	} {
		if got := icuPlaceholders(msg); got != want {
			t.Errorf("icuPlaceholders(%q) = %q, want %q", msg, got, want)
		}
	}
}
