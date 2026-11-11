// Package tunnelcmd implements `rclone tunnel`, which rcui adds to rclone's command line (as it
// does with update). It runs rclone's rc server on a loopback port with random credentials, with
// the built-in cloudflared in front of it on a trycloudflare.com address. The pairing QR code
// holds {url, user, pass}, which the Rclone UI mobile app reads. It exposes rclone's full rc API
// on purpose. Whatever the phone starts runs in this process and ends with it.
//
// The Mobile & Remote Control window runs it as a child process of the app, with the config file.
// Anyone can also run it in a terminal, where it prints the QR code. rclone's rcd is left as
// rclone ships it.
package tunnelcmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"time"

	"github.com/rclone/rclone/cmd"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/rc"
	"github.com/rclone/rclone/fs/rc/rcserver"
	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/rclone/rclone-ui/core/children/childenv"
	"github.com/rclone/rclone-ui/core/internal/freeport"
	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/tunnel/cloudflared"
)

// Edge puts the rc server on the internet. It is cloudflared.Start, or a stand-in in tests.
type Edge func(ctx context.Context, origin string, o cloudflared.Options) (*cloudflared.Tunnel, error)

// startWait limits how long to wait for cloudflared to be served.
const startWait = 90 * time.Second

// Install adds `tunnel` to rclone's root command.
func Install(root *cobra.Command, edge Edge) {
	root.AddCommand(&cobra.Command{
		Use:   "tunnel",
		Short: "Pair the Rclone UI mobile app: rclone's rc on a public address.",
		Long: `Runs rclone's remote control server on a public trycloudflare.com address,
behind a Cloudflare quick tunnel, for the Rclone UI mobile app. It prints the
address, a user and a password, and a QR code with all three to scan in the
app. It runs until you stop it (Ctrl-C).

The user and password are random unless --rc-user and --rc-pass give them.
Anyone who has them can use every remote in your config, as the app can.

The mobile app's downloads and thumbnails run rclone commands through the rc's
core/command; they use this command's config, its password included.`,
		Annotations: map[string]string{"groups": "RC"},
		// Not childenv.Ready: loadConfig reads the key file itself, and PrivateRC runs once the
		// rc is up.
		PersistentPreRun: func(*cobra.Command, []string) {},
		Run: func(command *cobra.Command, args []string) {
			cmd.CheckArgs(0, 0, command, args)
			if err := run(command, edge); err != nil {
				fs.Fatalf(nil, "tunnel: %v", err)
			}
		},
	})
}

// servedLine is the notice that the command logs once the tunnel is served. The app reads the
// address from it.
const servedLine = "The tunnel is on at "

var servedRe = regexp.MustCompile(regexp.QuoteMeta(servedLine) + `(https://[^\s"\\]+)`)

// ServedURL returns the address in the command's "served" log line, or "".
func ServedURL(line string) string {
	if m := servedRe.FindStringSubmatch(line); m != nil {
		return m[1]
	}
	return ""
}

func run(command *cobra.Command, edge Edge) error {
	ctx := context.Background()
	if rc.Opt.Enabled {
		return errors.New("don't supply --rc: the tunnel serves the rc itself")
	}
	if rc.Opt.Auth.HtPasswd != "" {
		return errors.New("the QR carries a user and password: use --rc-user and --rc-pass, not --rc-htpasswd")
	}
	if rc.Opt.Auth.BasicUser == "" {
		rc.Opt.Auth.BasicUser = ids.Hex(8)
	}
	if rc.Opt.Auth.BasicPass == "" {
		rc.Opt.Auth.BasicPass = ids.Hex(16)
	}
	free, err := freeport.Loopback()
	if err != nil {
		return err
	}
	origin := free.String()
	// Keep the app's own socket (a child's --rc-addr), but replace rclone's default address.
	if command.Flags().Changed("rc-addr") {
		rc.Opt.HTTP.ListenAddr = append(rc.Opt.HTTP.ListenAddr, origin)
	} else {
		rc.Opt.HTTP.ListenAddr = []string{origin}
	}
	// The phone downloads objects over the rc, and reads a job's result after it finishes.
	rc.Opt.Serve = true
	if !command.Flags().Changed("rc-job-expire-duration") {
		rc.Opt.JobExpireDuration = fs.Duration(24 * time.Hour)
	}
	if !command.Flags().Changed("rc-job-expire-interval") {
		rc.Opt.JobExpireInterval = fs.Duration(time.Hour)
	}

	// Load the config now, so an encrypted one asks for its password here rather than at the
	// phone's first request. Its key is kept for core/command's subprocesses.
	if err := loadConfig(); err != nil {
		return err
	}
	installCommand()
	rc.Opt.Enabled = true
	s, err := rcserver.Start(ctx, &rc.Opt)
	if err != nil {
		return fmt.Errorf("starting the rc: %w", err)
	}
	childenv.PrivateRC()

	ci := fs.GetConfig(ctx)
	sctx, cancel := context.WithTimeout(ctx, startWait)
	t, err := edge(sctx, "http://"+origin, cloudflared.Options{LogLevel: cloudflaredLevel(ci.LogLevel), JSON: ci.UseJSONLog})
	cancel()
	if err != nil {
		return err
	}
	fs.Logf(nil, "%s%s", servedLine, t.URL)
	if term.IsTerminal(int(os.Stdout.Fd())) {
		printPairing(t.URL, rc.Opt.Auth.BasicUser, rc.Opt.Auth.BasicPass)
	}

	served := make(chan struct{})
	go func() {
		s.Wait()
		close(served)
	}()
	select {
	case err := <-t.Done:
		if err == nil {
			err = errors.New("it stopped")
		}
		return fmt.Errorf("cloudflared: %w", err)
	case <-served:
		return nil
	}
}

// cloudflaredLevel converts rclone's log level to cloudflared's. cloudflared's info lines match
// rclone's info, and a plain run (rclone's notice) shows cloudflared's warnings. It never returns
// debug, because at debug cloudflared logs each request's headers, including the rc's basic
// auth, which would open the rc to anyone who has the log.
func cloudflaredLevel(l fs.LogLevel) string {
	switch {
	case l >= fs.LogLevelInfo:
		return "info"
	case l >= fs.LogLevelNotice:
		return "warn"
	}
	return "error"
}
