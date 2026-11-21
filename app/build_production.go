//go:build production

package app

import "github.com/wailsapp/wails/v3/pkg/application"

// production is true in a release build, which embeds the pages, has no devtools and registers
// deep links.
const production = true

func (u *ui) devEval() {}

func (u *ui) devServices() []application.Service { return nil }

// testFeed returns "", because a release build always checks the real update feed.
func testFeed() string { return "" }
