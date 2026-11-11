// Package locales holds the app's translations, one folder per language (see README.md):
//
//	<language>/app.po       the windows' text (Lingui, lib/i18n.ts)
//	<language>/core.po      the Go side's text (core/i18n)
//	<language>/rclone.json  rclone's own descriptions and option help
//
// languages.json lists the languages that the app offers, each under its own name. The en folder
// holds the English text that the others translate, which `npm run i18n` writes from the code.
// The pseudo folder is the windows' test language, which only a dev build offers.
package locales

import "embed"

//go:embed languages.json */core.po */rclone.json
var FS embed.FS
