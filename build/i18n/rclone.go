package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const sep = "\x00"

const rcloneFile = "rclone.json"

func runRclone(dir string, prune bool) error {
	cmd := exec.Command("go", "run", "./build/i18n/rclonetext")
	cmd.Dir = dir
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("build/i18n/rclonetext: %w", err)
	}
	var live map[string]string
	if err := json.Unmarshal(out, &live); err != nil {
		return fmt.Errorf("build/i18n/rclonetext: %w", err)
	}
	src, err := rcloneSource(dir)
	if err != nil {
		return err
	}
	setup, err := collectSetup(src)
	if err != nil {
		return fmt.Errorf("rclone's source: %w", err)
	}
	for _, problem := range addSetup(live, setup) {
		fmt.Fprintln(os.Stderr, "i18n: "+problem)
	}
	fmt.Fprintln(os.Stderr, "i18n: "+setup.report())
	langs, err := languages(dir)
	if err != nil {
		return err
	}
	files := map[string]map[string]string{}
	for _, lang := range langs {
		if files[lang], err = readTexts(filepath.Join(dir, "locales", lang, rcloneFile)); err != nil {
			return err
		}
	}
	report := mergeRclone(live, files, prune)
	for _, lang := range langs {
		if err := writeTexts(filepath.Join(dir, "locales", lang, rcloneFile), files[lang]); err != nil {
			return err
		}
	}
	fmt.Fprintln(os.Stderr, "i18n: "+report)
	return nil
}

func addSetup(live map[string]string, setup *setupSource) []string {
	var problems []string
	for _, u := range setup.unread {
		problems = append(problems, "rclone's source: "+u)
	}
	keys := setup.keys()
	for _, k := range slices.Sorted(maps.Keys(keys)) {
		if old, ok := live[k]; ok && old != keys[k] {
			problems = append(problems, fmt.Sprintf("rclone's source and registry give %s other texts: %q and %q, so the registry's is kept", strings.ReplaceAll(k, sep, "."), keys[k], old))
			continue
		}
		live[k] = keys[k]
	}
	return problems
}

func mergeRclone(live map[string]string, files map[string]map[string]string, prune bool) string {
	en := files["en"]
	if en == nil {
		en = map[string]string{}
		files["en"] = en
	}
	sameText := map[string]string{}
	for _, k := range slices.Sorted(maps.Keys(en)) {
		if id := scopedText(k, en[k]); sameText[id] == "" {
			sameText[id] = k
		}
	}
	carried := map[string]map[string]string{}
	for k, text := range live {
		if old, ok := en[k]; ok && old == text {
			continue
		}
		from := sameText[scopedText(k, text)]
		if from == "" {
			continue
		}
		for lang, f := range files {
			if lang != "en" && f[from] != "" {
				if carried[lang] == nil {
					carried[lang] = map[string]string{}
				}
				carried[lang][k] = f[from]
			}
		}
	}
	added, changed, kept, dropped := 0, 0, 0, 0
	for k, text := range live {
		old, ok := en[k]
		switch {
		case !ok:
			added++
		case old != text:
			changed++
			for lang, f := range files {
				if lang != "en" {
					delete(f, k)
				}
			}
		}
		en[k] = text
	}
	for lang, translations := range carried {
		f := files[lang]
		for k, s := range translations {
			if _, has := f[k]; !has {
				f[k] = s
			}
		}
	}
	for k := range en {
		if _, ok := live[k]; ok {
			continue
		}
		if !prune {
			kept++
			continue
		}
		dropped++
		delete(en, k)
	}
	if prune {
		for lang, f := range files {
			if lang == "en" {
				continue
			}
			for k := range f {
				if _, ok := en[k]; !ok {
					delete(f, k)
				}
			}
		}
	}
	report := fmt.Sprintf("rclone's text: %d keys, %d new, %d changed", len(en), added, changed)
	if prune {
		return report + fmt.Sprintf(", %d dropped", dropped)
	}
	return report + fmt.Sprintf(", %d kept that this rclone lacks (-prune drops them)", kept)
}

func scopedText(key, text string) string {
	parts := strings.SplitN(key, sep, 3)
	if len(parts) < 3 {
		return key + sep + text
	}
	return parts[0] + sep + parts[1] + sep + text
}

func reviewRclone(dir string, langs []string) (problems, warnings []string, err error) {
	enPath := filepath.Join(dir, "locales", "en", rcloneFile)
	en, err := readTexts(enPath)
	if err != nil {
		return nil, nil, err
	}
	if len(en) == 0 {
		return nil, []string{rel(dir, enPath) + " is missing: run go run ./build/i18n -rclone"}, nil
	}
	for _, lang := range langs {
		if lang == "en" {
			continue
		}
		path := filepath.Join(dir, "locales", lang, rcloneFile)
		f, err := readTexts(path)
		if err != nil {
			return nil, nil, err
		}
		missing, extra := 0, 0
		for _, k := range slices.Sorted(maps.Keys(en)) {
			s, ok := f[k]
			if !ok {
				missing++
				continue
			}
			if !setupFormat(k) {
				continue
			}
			if want, got := verbs(en[k], false), verbs(s, false); want != got {
				problems = append(problems, fmt.Sprintf("%s: the translation of %s has other placeholders (%s) than the English (%s)", rel(dir, path), strings.ReplaceAll(k, sep, "."), orNone(got), orNone(want)))
			}
		}
		for k := range f {
			if _, ok := en[k]; !ok {
				extra++
			}
		}
		if missing > 0 {
			warnings = append(warnings, fmt.Sprintf("%s: no translation for %d of rclone's %d texts", rel(dir, path), missing, len(en)))
		}
		if extra > 0 {
			warnings = append(warnings, fmt.Sprintf("%s: keys that en/rclone.json no longer has: %d (go run ./build/i18n -rclone -prune drops them)", rel(dir, path), extra))
		}
	}
	return problems, warnings, nil
}

var helpVariant = regexp.MustCompile(`^help(_[0-9]+)?$`)

func setupFormat(key string) bool {
	parts := strings.Split(key, sep)
	n := len(parts)
	if parts[0] != "setup" || !helpVariant.MatchString(parts[n-1]) {
		return false
	}
	switch {
	case n == 3:
		return parts[1] == "error"
	case n == 4:
		return parts[1] == "question"
	case n == 5:
		return parts[1] == "backend" && parts[3] == "error"
	case n == 6:
		return parts[1] == "backend" && parts[3] == "question"
	}
	return false
}

func readTexts(path string) (map[string]string, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var tree map[string]any
	if err := json.Unmarshal(b, &tree); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	out := map[string]string{}
	var walk func(prefix string, node map[string]any) error
	walk = func(prefix string, node map[string]any) error {
		for k, v := range node {
			if prefix != "" {
				k = prefix + sep + k
			}
			switch v := v.(type) {
			case string:
				out[k] = v
			case map[string]any:
				if err := walk(k, v); err != nil {
					return err
				}
			default:
				return fmt.Errorf("%s: %s is neither a text nor an object", path, strings.ReplaceAll(k, sep, "."))
			}
		}
		return nil
	}
	return out, walk("", tree)
}

func writeTexts(path string, texts map[string]string) error {
	if len(texts) == 0 {
		return nil
	}
	tree := map[string]any{}
	for _, k := range slices.Sorted(maps.Keys(texts)) {
		parts := strings.Split(k, sep)
		node := tree
		for _, p := range parts[:len(parts)-1] {
			next, ok := node[p].(map[string]any)
			if !ok {
				next = map[string]any{}
				node[p] = next
			}
			node = next
		}
		node[parts[len(parts)-1]] = texts[k]
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(tree); err != nil {
		return err
	}
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, b.Bytes()) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, b.Bytes(), 0o644)
}
