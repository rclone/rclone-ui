package catalog

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"

	"github.com/rclone/rclone-ui/core/i18n"
)

// translated returns lang's translation of the text at k, and fails when the file has none that
// differs from English.
func translated(t *testing.T, lang, k string) string {
	t.Helper()
	local, err := readTexts(lang)
	if err != nil {
		t.Fatal(err)
	}
	if local[k] == "" || local[k] == englishFile()[k] {
		t.Fatalf("%s/rclone.json has no translation for %q", lang, k)
	}
	return local[k]
}

func TestSummaryIn(t *testing.T) {
	s := New("")
	local, _ := fs.Find("local")
	transfers := fs.OptionsRegistry["main"].Options.Get("transfers")
	for _, lang := range []string{"es", "zh-CN"} {
		sum := s.SummaryIn(lang)
		b := backend(t, sum, "local")
		if want := translated(t, lang, key("backend", "local", "description")); b.Description != want {
			t.Errorf("%s: local's description is %q, want %q", lang, b.Description, want)
		}
		if b.MetadataInfo == nil || b.MetadataInfo.Help == local.MetadataInfo.Help {
			t.Errorf("%s: local's metadata help isn't translated", lang)
		}
		if b.MetadataInfo.System["mtime"].Type != local.MetadataInfo.System["mtime"].Type {
			t.Errorf("%s: the metadata's types changed", lang)
		}
		o := option(t, block(t, sum, "main"), "transfers")
		if want := translated(t, lang, key("options", "main", "option", "transfers", "help")); o.Help != want {
			t.Errorf("%s: --transfers' help is %q, want %q", lang, o.Help, want)
		}
		if !o.PerOperation || o.Kind != KindInt {
			t.Errorf("%s: --transfers lost its fields: %+v", lang, o)
		}
		if s.SummaryIn(lang) != sum {
			t.Errorf("%s: the summary isn't kept", lang)
		}
		if sum.Version != s.Summary().Version || len(sum.Groups) != len(s.Summary().Groups) {
			t.Errorf("%s: the summary's version or groups changed", lang)
		}
	}

	// Validation, command building and the English pages read the English catalog, which the
	// translated summaries leave alone.
	if got := backend(t, s.Summary(), "local").Description; got != local.Description {
		t.Errorf("Summary's local description became %q", got)
	}
	if got := backend(t, s.Catalog(), "local").Description; got != local.Description {
		t.Errorf("Catalog's local description became %q", got)
	}
	if got := option(t, block(t, s.Catalog(), "main"), "transfers").Help; got != transfers.Help {
		t.Errorf("Catalog's --transfers help became %q", got)
	}
	if got := option(t, blockOptions()["main"], "transfers").Help; got != transfers.Help {
		t.Errorf("the block options' --transfers help became %q", got)
	}
	if transfers.Help != englishFile()[key("options", "main", "option", "transfers", "help")] {
		t.Errorf("rclone's own --transfers help changed: %q", transfers.Help)
	}

	// English and the pseudo-language get the English summary itself.
	for _, lang := range []string{i18n.English, i18n.Pseudo, "fr"} {
		if s.SummaryIn(lang) != s.Summary() {
			t.Errorf("%s: SummaryIn isn't the English summary", lang)
		}
	}
}

// The agents' server reads the English catalog whatever the app's language.
func TestEnglishWhateverTheLanguage(t *testing.T) {
	i18n.SetLanguage("es")
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	a := NewAPI(New(""), nil)
	got, _ := a.Get(context.Background())
	english, _ := a.English(context.Background())
	want := fs.OptionsRegistry["main"].Options.Get("transfers").Help
	if option(t, block(t, &got, "main"), "transfers").Help == want {
		t.Fatal("Get is in English, so this test shows nothing")
	}
	if help := option(t, block(t, &english, "main"), "transfers").Help; help != want {
		t.Errorf("English's --transfers help is %q", help)
	}
}

func TestBackendIn(t *testing.T) {
	s := New("")
	ri, _ := fs.Find("s3")
	// The help of one of AWS's ACL examples, under the key that its provider list gives it.
	var acl *fs.Option
	for i := range ri.Options {
		if o := &ri.Options[i]; o.Name == "acl" && fs.MatchProvider(o.Provider, "AWS") {
			acl = o
		}
	}
	var example *fs.OptionExample
	for i := range acl.Examples {
		if ex := &acl.Examples[i]; ex.Value == "public-read" && fs.MatchProvider(ex.Provider, "AWS") {
			example = ex
		}
	}
	if example == nil {
		t.Fatal("s3 has no public-read ACL for AWS")
	}
	for _, lang := range []string{"es", "zh-CN"} {
		view, err := s.BackendIn("s3", "AWS", lang)
		if err != nil {
			t.Fatal(err)
		}
		if want := translated(t, lang, key("backend", "s3", "description")); view.Backend.Description != want {
			t.Errorf("%s: s3's description is %q, want %q", lang, view.Backend.Description, want)
		}
		provider := option(t, view.Backend.Options, "provider")
		if want := translated(t, lang, key("backend", "s3", "option", "provider", "help")); provider.Help != want {
			t.Errorf("%s: provider's help is %q, want %q", lang, provider.Help, want)
		}
		want := translated(t, lang, exampleKey(backendPrefix("s3"), acl, example))
		i := slices.IndexFunc(option(t, view.Backend.Options, "acl").Choices, func(c Choice) bool { return c.Value == "public-read" })
		if i < 0 || option(t, view.Backend.Options, "acl").Choices[i].Help != want {
			t.Errorf("%s: the public-read ACL's help isn't %q", lang, want)
		}
	}
	// English, and the English Backend that the forms' checks read.
	for _, lang := range []string{i18n.English, i18n.Pseudo} {
		view, _ := s.BackendIn("s3", "AWS", lang)
		if option(t, view.Backend.Options, "provider").Help != ri.Options.Get("provider").Help || view.Backend.Description != ri.Description {
			t.Errorf("%s: s3 isn't in English", lang)
		}
	}
	plain, _ := s.Backend("s3", "AWS")
	if plain.Backend.Description != ri.Description {
		t.Errorf("Backend's s3 description became %q", plain.Backend.Description)
	}
}

func TestTextFallsBackToEnglish(t *testing.T) {
	k := key("backend", "local", "description")
	tr := &texts{
		en:    map[string]string{k: "Local Disk"},
		local: map[string]string{k: "Disco local"},
	}
	if got := tr.text(k, "Local Disk"); got != "Disco local" {
		t.Errorf("a translated text gives %q", got)
	}
	// A key that the language lacks, or that en lacks.
	missing := key("backend", "local", "option", "nounc", "help")
	if got := tr.text(missing, "Disable UNC"); got != "Disable UNC" {
		t.Errorf("a missing key gives %q", got)
	}
	tr.en[missing] = "Disable UNC"
	if got := tr.text(missing, "Disable UNC"); got != "Disable UNC" {
		t.Errorf("a key without a translation gives %q", got)
	}
	// rclone's text changed since it was translated.
	if got := tr.text(k, "Local disk"); got != "Local disk" {
		t.Errorf("a stale translation gives %q", got)
	}
	// No translations at all.
	var none *texts
	if got := none.text(k, "Local Disk"); got != "Local Disk" {
		t.Errorf("English gives %q", got)
	}
	o := fs.Option{Name: "x", Help: "Help", Examples: fs.OptionExamples{{Value: "", Help: "None"}}}
	if got := none.option("backend\x00local", o); got.Help != "Help" || &got.Examples[0] != &o.Examples[0] {
		t.Error("English copies an option")
	}
}

func TestEnglishTextsKeys(t *testing.T) {
	en := EnglishTexts()
	for _, k := range []string{
		key("backend", "local", "description"),
		key("backend", "local", "extra", "metadatainfo", "system", "mtime", "help"),
		key("backend", "drive", "extra", "commandhelp", "get", "short"),
		key("options", "main", "option", "transfers", "help"),
		key("setup", "question", "config_is_local", "help"),
		key("setup", "confirm", "example", "true", "help"),
	} {
		if en[k] == "" {
			t.Errorf("no English text at %q", k)
		}
	}
	// An example whose value is "" is keyed __empty__.
	found := false
	for k := range en {
		if slices.Contains(strings.Split(k, sep), emptyValue) {
			found = true
			break
		}
	}
	if !found {
		t.Error("no example is keyed " + emptyValue)
	}
}

// token is a sign-in that rclone reads without the network, for a backend's config steps that
// follow one.
const token = `{"access_token":"a","token_type":"Bearer","refresh_token":"r","expiry":"2030-01-01T00:00:00Z"}`

// ask runs a step of a backend's own config, as a session does, and returns what rclone asks or
// shows. The steps that tests run need no network.
func ask(t *testing.T, backend, state, result string, m configmap.Simple) *fs.ConfigOut {
	t.Helper()
	ri, err := fs.Find(backend)
	if err != nil {
		t.Fatal(err)
	}
	out, err := ri.Config(context.Background(), "rcui-test", m, fs.ConfigIn{State: state, Result: result})
	if err != nil || out == nil || out.Option == nil && out.Error == "" {
		t.Fatalf("%s at %q gives %+v, %v", backend, state, out, err)
	}
	return out
}

// choice returns the help of a question's choice.
func choice(t *testing.T, q *Option, value string) string {
	t.Helper()
	i := slices.IndexFunc(q.Choices, func(c Choice) bool { return c.Value == value })
	if i < 0 {
		t.Fatalf("%s has no choice %q: %+v", q.Name, value, q.Choices)
	}
	return q.Choices[i].Help
}

// variantKey returns the key of the text in group (a question's key, or the errors') whose
// English is format.
func variantKey(t *testing.T, group, format string) string {
	t.Helper()
	for k, text := range englishFile() {
		if g, ok := setupGroup(k); ok && g == group && text == format {
			return k
		}
	}
	t.Fatalf("en/rclone.json has no %q under %s", format, strings.ReplaceAll(group, sep, "."))
	return ""
}

func TestFromQuestion(t *testing.T) {
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	var isLocal *fs.Option
	for _, q := range setupQuestions() {
		if q.Name == "config_is_local" {
			isLocal = q
		}
	}
	if isLocal == nil {
		t.Fatal("rclone's OAuth setup doesn't ask config_is_local")
	}
	// Two backends' own config_type, each with its fixed choices.
	jottaType := ask(t, "jottacloud", "", "", configmap.Simple{}).Option
	oneDriveType := ask(t, "onedrive", "choose_type", "", configmap.Simple{"token": token}).Option
	// Two backends' own config_password, a yes or no question, and a question whose choices are
	// the user's drives.
	jottaPassword := ask(t, "jottacloud", "legacy_username", "", configmap.Simple{}).Option
	sugarPassword := ask(t, "sugarsync", "password", "", configmap.Simple{}).Option
	nonStandard := ask(t, "jottacloud", "choose_device", "", configmap.Simple{}).Option
	drives, _ := fs.ConfigChoose("driveid_final", "config_driveid", "Select drive you want to use", 1, func(int) (string, string) {
		return "b!xyz", "Documents (business)"
	})
	in := func(backend string, parts ...string) string {
		return key(append([]string{"setup", "backend", backend, "question"}, parts...)...)
	}

	i18n.SetLanguage(i18n.English)
	if q := FromQuestion("onedrive", isLocal); q.Help != isLocal.Help || q.Choices[0].Help != "Yes" {
		t.Errorf("English: %+v", q)
	}
	if q := FromQuestion("jottacloud", jottaType); q.Help != jottaType.Help || choice(t, q, "standard") != jottaType.Examples[0].Help {
		t.Errorf("English: %+v", q)
	}
	for _, lang := range []string{"es", "zh-CN"} {
		i18n.SetLanguage(lang)
		yes := translated(t, lang, key("setup", "confirm", "example", "true", "help"))

		// rclone's common questions, whatever the backend.
		q := FromQuestion("onedrive", isLocal)
		if want := translated(t, lang, key("setup", "question", "config_is_local", "help")); q.Help != want {
			t.Errorf("%s: config_is_local is %q, want %q", lang, q.Help, want)
		}
		if q.Kind != KindBool || q.Choices[0].Value != "true" || q.Choices[0].Help != yes {
			t.Errorf("%s: the answers are %+v", lang, q.Choices)
		}

		// A backend's own question, with its fixed choices.
		q = FromQuestion("jottacloud", jottaType)
		if want := translated(t, lang, in("jottacloud", "config_type", "help")); q.Help != want {
			t.Errorf("%s: jottacloud's config_type is %q, want %q", lang, q.Help, want)
		}
		if want := translated(t, lang, in("jottacloud", "config_type", "example", "standard", "help")); choice(t, q, "standard") != want || !q.Exclusive {
			t.Errorf("%s: jottacloud's standard choice is %q, want %q", lang, choice(t, q, "standard"), want)
		}
		q = FromQuestion("onedrive", oneDriveType)
		if want := translated(t, lang, in("onedrive", "config_type", "help")); q.Help != want {
			t.Errorf("%s: onedrive's config_type is %q, want %q", lang, q.Help, want)
		}
		if want := translated(t, lang, in("onedrive", "config_type", "example", "sharepoint", "help")); choice(t, q, "sharepoint") != want {
			t.Errorf("%s: onedrive's sharepoint choice is %q, want %q", lang, choice(t, q, "sharepoint"), want)
		}
		// The same name in another backend is another question, which stays English.
		if q := FromQuestion("onedrive", jottaType); q.Help != jottaType.Help || choice(t, q, "standard") != jottaType.Examples[0].Help {
			t.Errorf("%s: jottacloud's config_type as onedrive's gives %+v", lang, q)
		}
		for _, c := range []struct {
			backend string
			q       *fs.Option
		}{{"jottacloud", jottaPassword}, {"sugarsync", sugarPassword}} {
			if want := translated(t, lang, in(c.backend, "config_password", "help")); FromQuestion(c.backend, c.q).Help != want {
				t.Errorf("%s: %s's config_password is %q, want %q", lang, c.backend, FromQuestion(c.backend, c.q).Help, want)
			}
		}
		if q := FromQuestion("sugarsync", jottaPassword); q.Help != jottaPassword.Help {
			t.Errorf("%s: jottacloud's password as sugarsync's gives %q", lang, q.Help)
		}
		// A backend's yes or no question.
		q = FromQuestion("jottacloud", nonStandard)
		if want := translated(t, lang, in("jottacloud", "config_non_standard", "help")); q.Help != want || q.Choices[0].Help != yes {
			t.Errorf("%s: config_non_standard gives %+v", lang, q)
		}
		// The user's drives keep their names.
		q = FromQuestion("onedrive", drives.Option)
		if want := translated(t, lang, in("onedrive", "config_driveid", "help")); q.Help != want || choice(t, q, "b!xyz") != "Documents (business)" {
			t.Errorf("%s: config_driveid gives %+v", lang, q)
		}
		// A text that rclone changed stays English, with the choices that it still has.
		changed := *jottaType
		changed.Help = "Type of authentication to use."
		if q := FromQuestion("jottacloud", &changed); q.Help != changed.Help || choice(t, q, "standard") == jottaType.Examples[0].Help {
			t.Errorf("%s: a changed question gives %+v", lang, q)
		}
		if jottaType.Help == FromQuestion("jottacloud", jottaType).Help || isLocal.Examples[0].Help != "Yes" {
			t.Errorf("%s: FromQuestion changed rclone's question", lang)
		}
	}
	i18n.SetLanguage(i18n.Pseudo)
	for _, c := range []struct {
		backend string
		q       *fs.Option
	}{{"onedrive", isLocal}, {"jottacloud", jottaType}} {
		if q := FromQuestion(c.backend, c.q); q.Help != c.q.Help || q.Choices[0].Help != c.q.Examples[0].Help {
			t.Errorf("the pseudo-language translates rclone's text: %+v", q)
		}
	}
	if FromQuestion("onedrive", nil) != nil {
		t.Error("no question gives a question")
	}
}

// The questions whose text holds values get them in their translation.
func TestFromQuestionWithValues(t *testing.T) {
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	// Drive's own question, about the Shared Drive that the remote has.
	teamDrive := ask(t, "drive", "teamdrive", "", configmap.Simple{"team_drive": "0AbC-12"}).Option
	// The common question about rclone's shared client_id, which drive asks with its name.
	shared := ask(t, "drive", "client_id", "", configmap.Simple{}).Option
	// OneDrive's drive, which it finds online, so its question is made here as rclone makes it:
	// with the format that en/rclone.json holds, and a name that needs quoting.
	okKey := key("setup", "backend", "onedrive", "question", "config_drive_ok", "help")
	driveOK, _ := fs.ConfigConfirm("driveid_final_end", true, "config_drive_ok",
		fmt.Sprintf(englishFile()[okKey], `My "Docs"`, "business", "https://contoso.sharepoint.com/x"))
	teamKey := variantKey(t, key("setup", "backend", "drive", "question", "config_change_team_drive"), "Change current Shared Drive (Team Drive) ID %q?\n")

	for _, lang := range []string{"es", "zh-CN"} {
		i18n.SetLanguage(lang)
		if got, want := FromQuestion("drive", teamDrive).Help, fmt.Sprintf(translated(t, lang, teamKey), "0AbC-12"); got != want {
			t.Errorf("%s: config_change_team_drive is %q, want %q", lang, got, want)
		}
		want := fmt.Sprintf(translated(t, lang, key("setup", "question", "config_shared_client_id", "help")),
			"Google Drive", "https://rclone.org/drive/#making-your-own-client-id")
		if got := FromQuestion("drive", shared).Help; got != want || shared.Help == want {
			t.Errorf("%s: config_shared_client_id is %q, want %q", lang, got, want)
		}
		got := FromQuestion("onedrive", driveOK.Option).Help
		if want := fmt.Sprintf(translated(t, lang, okKey), `My "Docs"`, "business", "https://contoso.sharepoint.com/x"); got != want {
			t.Errorf("%s: config_drive_ok is %q, want %q", lang, got, want)
		}
		if !strings.Contains(got, `"My \"Docs\""`) || !strings.Contains(got, "https://contoso.sharepoint.com/x") {
			t.Errorf("%s: config_drive_ok lost its values: %q", lang, got)
		}
	}
	// The Chinese translation names the drive's type before its name.
	i18n.SetLanguage("zh-CN")
	got := FromQuestion("onedrive", driveOK.Option).Help
	if strings.Index(got, `"business"`) > strings.Index(got, `"My \"Docs\""`) {
		t.Errorf("zh-CN: config_drive_ok keeps the English order: %q", got)
	}
}

func TestLocalNotice(t *testing.T) {
	t.Cleanup(func() { i18n.SetLanguage(i18n.English) })
	// Seafile refuses a blank 2FA code, with an error that it shows before it asks again.
	seafile := configmap.Simple{"url": "https://seafile.invalid", "user": "me", "2fa": "true", "pass": "x"}
	blank := ask(t, "seafile", "2fa_do", "", seafile).Error
	errors := func(backend string) string { return key("setup", "backend", backend, "error") }
	drives := "Failed to query available drives: /me/drives: 401; /me/drive: 403\nEnter the drive ID manually instead"
	for _, lang := range []string{"es", "zh-CN"} {
		i18n.SetLanguage(lang)
		if want := translated(t, lang, variantKey(t, errors("seafile"), "2FA codes can't be blank")); LocalNotice("seafile", blank) != want {
			t.Errorf("%s: seafile's blank code is %q, want %q", lang, LocalNotice("seafile", blank), want)
		}
		// Of OneDrive's two errors about its drives, the longer one is found first.
		want := fmt.Sprintf(translated(t, lang, variantKey(t, errors("onedrive"), "Failed to query available drives: /me/drives: %v; /me/drive: %v\nEnter the drive ID manually instead")), "401", "403")
		if got := LocalNotice("onedrive", drives); got != want {
			t.Errorf("%s: onedrive's drives error is %q, want %q", lang, got, want)
		}
		want = fmt.Sprintf(translated(t, lang, variantKey(t, errors("onedrive"), "Failed to query available drives: %v")), "401: unauthorized")
		if got := LocalNotice("onedrive", "Failed to query available drives: 401: unauthorized"); got != want {
			t.Errorf("%s: onedrive's other drives error is %q, want %q", lang, got, want)
		}
		// rclone's common config's error, whatever the backend.
		want = fmt.Sprintf(translated(t, lang, key("setup", "error", "help")), "invalid character")
		if got := LocalNotice("drive", "Couldn't decode response - try again (make sure you are using a matching version of rclone on both sides: invalid character\n"); got != want {
			t.Errorf("%s: the sign-in's error is %q, want %q", lang, got, want)
		}
		// Another backend's error, and one that the files lack, stay English.
		for _, c := range [][2]string{{"drive", blank}, {"seafile", "Something else went wrong"}, {"seafile", ""}} {
			if got := LocalNotice(c[0], c[1]); got != c[1] {
				t.Errorf("%s: %s's %q gives %q", lang, c[0], c[1], got)
			}
		}
	}
	for _, lang := range []string{i18n.English, i18n.Pseudo} {
		i18n.SetLanguage(lang)
		if got := LocalNotice("seafile", blank); got != blank {
			t.Errorf("%s: seafile's error is %q", lang, got)
		}
	}
}

func TestSetupTextFallsBackToEnglish(t *testing.T) {
	group := key("setup", "backend", "onedrive", "question", "config_drive_ok")
	other := key("setup", "backend", "onedrive", "question", "config_count")
	tr := &texts{
		en: map[string]string{
			key(group, "help"):   "Found drive %q of type %q\nURL: %s\n",
			key(group, "help_2"): "Drive %q is 100%% full",
			key(other, "help"):   "Sent %d codes to %s",
			key(other, "help_2"): "Sent %v codes to %s, %s",
		},
		local: map[string]string{
			// A translation that puts the values in another order.
			key(group, "help"):   "Tipo %[2]q, unidad %[1]q\nURL: %[3]s\n",
			key(group, "help_2"): "La unidad %q está llena al 100 %%",
			key(other, "help"):   "%[2]s: %[1]d códigos",
			// A translation whose verbs don't fit its English.
			key(other, "help_2"): "%d códigos enviados a %d",
		},
	}
	for _, c := range []struct{ group, english, want string }{
		{group, "Found drive \"Docs\" of type \"business\"\nURL: https://x\n", "Tipo \"business\", unidad \"Docs\"\nURL: https://x\n"},
		{group, `Drive "a\"b" is 100% full`, `La unidad "a\"b" está llena al 100 %`},
		{other, "Sent 12 codes to +34 600", "+34 600: 12 códigos"},
		// The format with a verb that doesn't fit shows English.
		{other, "Sent 3 codes to a, b", "Sent 3 codes to a, b"},
		// Text that no format matches, because rclone changed it.
		{group, "Found drive \"Docs\" of kind \"business\"\nURL: https://x\n", "Found drive \"Docs\" of kind \"business\"\nURL: https://x\n"},
		{group, "Drive Docs is 100% full", "Drive Docs is 100% full"},
		{other, "Sent some codes to a", "Sent some codes to a"},
	} {
		if got := tr.setupText(c.english, c.group); got != c.want {
			t.Errorf("%q gives %q, want %q", c.english, got, c.want)
		}
	}
	var none *texts
	if got := none.setupText("Found drive \"Docs\"", group); got != "Found drive \"Docs\"" {
		t.Errorf("English gives %q", got)
	}
}

// Each setup question and error in en/rclone.json is a format that FromQuestion can match, and
// each translation of one takes its English values.
func TestSetupFormats(t *testing.T) {
	samples := map[byte]any{'q': `a "b"`, 's': "c", 'd': int64(7)}
	n := 0
	for k, format := range englishFile() {
		if _, ok := setupGroup(k); !ok {
			continue
		}
		n++
		f := newSetupFormat(k, format)
		if f == nil {
			t.Errorf("%s can't be matched: %q", strings.ReplaceAll(k, sep, "."), format)
			continue
		}
		values := make([]any, len(f.verbs))
		for i, v := range f.verbs {
			values[i] = samples[v]
		}
		if got, ok := f.match(fmt.Sprintf(format, values...)); !ok || !slices.Equal(got, values) {
			t.Errorf("%s doesn't match its own text: %v", strings.ReplaceAll(k, sep, "."), got)
		}
		for _, lang := range []string{"es", "zh-CN"} {
			if out := fmt.Sprintf(translated(t, lang, k), values...); strings.Contains(out, "%!") {
				t.Errorf("%s: %s doesn't take its values: %q", lang, strings.ReplaceAll(k, sep, "."), out)
			}
		}
	}
	if n < 60 {
		t.Errorf("en/rclone.json has %d setup texts", n)
	}
}
