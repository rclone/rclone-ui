//go:build production

package app

import "github.com/wailsapp/wails/v3/pkg/application"

const production = true

func (u *ui) devEval() {}

func (u *ui) devServices() []application.Service { return nil }

func testFeed() string { return "" }
