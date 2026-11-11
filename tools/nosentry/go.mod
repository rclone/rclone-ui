// The built-in cloudflared (core/tunnel/cloudflared) reports its errors to Cloudflare's Sentry.
// The root go.mod replaces the Sentry library with this module, whose functions do nothing, so
// the app sends no crash reports and the library isn't built in.
module github.com/getsentry/sentry-go

go 1.26.0
