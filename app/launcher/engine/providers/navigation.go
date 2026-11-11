package providers

import (
	"context"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/core/i18n"
)

// Navigation offers the app's own screens, GitHub and Quit.
type Navigation struct{}

// GitHubURL is the repository's page. The GitHub entry opens it here and in the tray menu.
const GitHubURL = "https://github.com/rclone/rclone-ui"

// screen is one of the rows that Navigation offers, with its title and its search words as
// messages (see engine.Result.Say). A zero title keeps the row's own, which is a name.
type screen struct {
	row          engine.Result
	title, words i18n.Text
}

// screens returns the rows of the app's screens, in the order that breaks their ties.
func screens() []screen {
	return []screen{{
		row: engine.Result{ID: "nav:settings", Key: "nav:settings", Subtitle: i18n.T("Open the Settings screen."), Icon: icons.Settings, Score: 34,
			Actions: []engine.Action{open("open", "Settings", "/settings", icons.Settings)}},
		title: i18n.M("Settings"),
		// i18n: Search words for the launcher's Settings row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("settings, preferences, proxy, about"),
	}, {
		row: engine.Result{ID: "nav:notifications", Key: "nav:notifications", Subtitle: i18n.T("Open the Notifications screen."), Icon: icons.Bell, Score: 26,
			Actions: []engine.Action{open("open", "Notifications", "/notifications", icons.Bell)}},
		title: i18n.M("Notifications"),
		// i18n: Search words for the launcher's Notifications row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("notifications, alerts, webhooks, email"),
	}, {
		row: engine.Result{ID: "nav:mobileRemoteControl", Key: "nav:mobileRemoteControl", Subtitle: i18n.T("Open the Remote Control screen to use Rclone UI from a phone."), Icon: icons.Mobile, Score: 25,
			Actions: []engine.Action{open("open", "MobileRemoteControl", "/mobileRemoteControl", icons.Mobile)}},
		// i18n: The screen that lets a phone use Rclone UI: the Mobile & Remote Control window, by its short name.
		title: i18n.M("Remote Control"),
		// i18n: Search words for the launcher's Remote Control row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("remote control, mobile, phone, tunnel, qr"),
	}, {
		row: engine.Result{ID: "nav:commander", Key: "nav:commander", Subtitle: i18n.T("Open the Commander screen."), Icon: icons.Commander, Score: 32,
			Actions: []engine.Action{{ID: "open", Name: i18n.T("Open Commander"), Icon: icons.Commander, Opens: true, Run: func(_ context.Context, env engine.Env) error {
				env.OpenFull("Commander", "/commander")
				return nil
			}}}},
		// i18n: The app's two-pane file manager.
		title: i18n.M("Commander"),
		// i18n: Search words for the launcher's Commander row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("commander, explorer, navigator, navigate, browse, files"),
	}, {
		// GitHub is a name, so its title isn't translated. Its search words are.
		row: engine.Result{ID: "nav:github", Key: "nav:github", Title: "GitHub", Subtitle: i18n.T("Open an issue or star the GitHub repo (we appreciate it)."), Icon: icons.GitHub, Score: 32,
			Actions: []engine.Action{{ID: "open", Name: i18n.T("Open GitHub"), Icon: icons.Browser, Run: func(_ context.Context, env engine.Env) error {
				env.OpenURL(GitHubURL)
				return nil
			}}}},
		// i18n: Search words for the launcher's GitHub row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("github, issue, bug, feature"),
	}, {
		row: engine.Result{ID: "nav:history", Key: "nav:history", Subtitle: i18n.T("Open the History screen."), Icon: icons.Transfers, Score: 30,
			Actions: []engine.Action{open("open", "History", "/history", icons.Transfers)}},
		title: i18n.M("History"),
		// i18n: Search words for the launcher's History row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("history, transfers, jobs, tasks"),
	}, {
		row: engine.Result{ID: "nav:templates", Key: "nav:templates", Subtitle: i18n.T("Open the Templates screen."), Icon: icons.Templates, Score: 28,
			Actions: []engine.Action{open("open", "Templates", "/templates", icons.Templates)}},
		title: i18n.M("Templates"),
		// i18n: Search words for the launcher's Templates row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("templates, examples, presets"),
	}, {
		row: engine.Result{ID: "nav:watchers", Key: "nav:watchers", Subtitle: i18n.T("Open the Watchers screen."), Icon: icons.Watchers, Score: 27,
			Actions: []engine.Action{open("open", "Watchers", "/watchers", icons.Watchers)}},
		title: i18n.M("Watchers"),
		// i18n: Search words for the launcher's Watchers row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("watchers, watch, keep in sync, dropbox, folders"),
	}, {
		row: engine.Result{ID: "nav:schedules", Key: "nav:schedules", Subtitle: i18n.T("Open the Schedules screen."), Icon: icons.Schedules, Score: 27,
			Actions: []engine.Action{open("open", "Schedules", "/schedules", icons.Schedules)}},
		title: i18n.M("Schedules"),
		// i18n: Search words for the launcher's Schedules row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("schedules, schedule, cron, every day, nightly, backup, timer"),
	}, {
		row: engine.Result{ID: "nav:guides", Key: "nav:guides", Subtitle: i18n.T("Learn more about what you can do with Rclone UI."), Icon: icons.Guides, Score: 29,
			Actions: []engine.Action{open("open", "Guides", "/guides", icons.Guides)}},
		title: i18n.M("Guides"),
		// i18n: Search words for the launcher's Guides row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("guides, help, how to, learn, tutorial, docs, getting started"),
	}, {
		row: engine.Result{ID: "nav:automounts", Key: "nav:automounts", Subtitle: i18n.T("Open the Automounts screen."), Icon: icons.Automounts, Score: 27,
			Actions: []engine.Action{open("open", "Automounts", "/automounts", icons.Automounts)}},
		title: i18n.M("Automounts"),
		// i18n: Search words for the launcher's Automounts row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("automounts, automount, auto mount, mount at login, startup"),
	}, {
		// no history key, so Quit is never suggested
		row: engine.Result{ID: "nav:quit", Subtitle: i18n.T("Quit the application."), Icon: icons.Quit, Score: 20,
			Actions: []engine.Action{{ID: "quit", Name: i18n.T("Quit"), Icon: icons.Quit, Run: func(_ context.Context, env engine.Env) error {
				env.Quit()
				return nil
			}}}},
		title: i18n.M("Quit"),
		// i18n: Search words for the launcher's Quit row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("quit, exit, close"),
	}}
}

func (Navigation) Query(context.Context, engine.Query, *engine.Data) []engine.Result {
	list := screens()
	out := make([]engine.Result, 0, len(list))
	for _, s := range list {
		out = append(out, s.row.Say(s.title, s.words))
	}
	return inGroup(engine.GroupApp, out)
}
