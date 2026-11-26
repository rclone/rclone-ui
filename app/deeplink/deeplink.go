package deeplink

import (
	"net/url"
	"strings"
)

const Scheme = "rclone"

type Link struct {
	URL    string
	Update *Update
}

type Update struct {
	// Version is the release to install. "" means the latest on the channel.
	Version string
	// Channel is "stable" or "beta". "" means the user's setting.
	Channel string
}

func UpdateLink(version, channel string) string {
	q := url.Values{}
	if version != "" {
		q.Set("version", version)
	}
	if channel != "" {
		q.Set("channel", channel)
	}
	return Scheme + "://update?" + q.Encode()
}

// IsLink reports whether s is an rclone:// link. The scheme is case-insensitive.
func IsLink(s string) bool {
	return strings.HasPrefix(strings.ToLower(s), Scheme+":")
}

func FromArgs(args []string) string {
	for _, a := range args {
		if IsLink(a) {
			return a
		}
	}
	return ""
}

// Parse parses a link of the form `add-template?cmd=…&name=…` or `update?version=…&channel=…`.
// It returns false for anything else. It accepts any number of slashes after the scheme, and a
// trailing slash before the query (`add-template/?cmd=…`), which some platforms add.
func Parse(raw string) (Link, bool) {
	if !IsLink(raw) {
		return Link{}, false
	}
	rest := strings.TrimLeft(raw[len(Scheme)+1:], "/")
	route, query, _ := strings.Cut(rest, "?")
	domain, _, _ := strings.Cut(route, "/")
	params, err := url.ParseQuery(query)
	if err != nil {
		params = url.Values{}
	}
	switch strings.ToLower(domain) {
	case "add-template":
		search := url.Values{}
		search.Set("action", "add")
		if cmd := strings.TrimSpace(params.Get("cmd")); cmd != "" {
			search.Set("cmd", cmd)
		}
		if name := strings.TrimSpace(params.Get("name")); name != "" {
			search.Set("name", name)
		}
		return Link{URL: "/templates?" + search.Encode()}, true
	case "update":
		return Link{Update: &Update{Version: params.Get("version"), Channel: params.Get("channel")}}, true
	}
	return Link{}, false
}
