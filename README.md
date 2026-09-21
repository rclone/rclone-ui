# Rclone Cloud

A web interface for [rclone](https://rclone.org): remotes, transfers, mounts, schedules and
notifications, served to a browser. One binary runs the HTTP API, the pages and rclone itself.

## Run it
### Docker
```sh
docker run -d --name rclone-cloud \
  -p 5573:5573 \
  -v rclone-cloud:/data \
  -v rclone-cloud-config:/config/rclone \
  ghcr.io/rclone/rclone-cloud
```

Open <http://localhost:5573>: the first visit creates the owner account. To seed it instead, set
`RCLONE_CLOUD_EMAIL` and `RCLONE_CLOUD_PASSWORD` together; the pair is ignored once accounts
exist. More accounts are added under Settings › Team.

Mounting needs FUSE in the container:

```sh
--device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined
```

and a bind mount with `:rshared` propagation for the mount to appear on the host. Without
`/dev/fuse` a mount fails with a note saying what is missing, a remote's Auto Mount setting is
hidden, and any remote set to mount on start is skipped with one line in the log — everything
else works. On Windows the same goes for [WinFsp](https://github.com/winfsp/winfsp). Installing
either is up to you; the server checks again at every mount and every daemon start, so no
restart is needed afterwards.

### Without Docker
Run the binary from the releases page: `rclone-cloud serve`. Under systemd or
launchd a self-update exits with code 3 and expects the supervisor to start it again.

## Configuration

Every flag has an environment variable.

| Flag | Variable | Default |
| --- | --- | --- |
| `--bind` | `RCLONE_CLOUD_BIND` | `127.0.0.1:5573` |
| `--email` | `RCLONE_CLOUD_EMAIL` | unset; with `--password`, seeds the owner account |
| `--password` | `RCLONE_CLOUD_PASSWORD` | unset; with `--email`, seeds the owner account (8 characters or more) |
| `--data-dir` | `RCLONE_CLOUD_DATA_DIR` | the platform's local data dir + `com.rclone.cloud` |
| `--rclone-path` | `RCLONE_CLOUD_RCLONE_PATH` | unset; the `rclone` on `PATH` |
| `--rclone-url` | `RCLONE_CLOUD_RCLONE_URL` | unset; manage the daemon instead |
| `--clear` | `RCLONE_CLOUD_CLEAR` | off |

Anything but loopback needs a password, and `--clear` empties the data directory before starting.

## Data

Everything the server itself keeps lives in the data directory: accounts (`state/team.json`),
settings (`state/app.json`), schedules (`scheduler/tasks/`) and their run history, the transfer
ledger, notification targets and SMTP settings, and the log file.

## rclone

The server runs the `rclone` on `PATH`, or the one `--rclone-path` names, and needs version
1.75.0 or newer. With an older one, or an older daemon behind `--rclone-url`, it stops before it
listens and says so: update with `rclone selfupdate`, then start it again.

A machine with no rclone gets the latest release installed at `/usr/local/bin/rclone`
(`%LOCALAPPDATA%\Microsoft\WindowsApps` on Windows), so it is on `PATH` for everybody. If the
server may not write there, it stops with the command to install rclone yourself.

There is one rclone. Installing a version from Settings › Rclone replaces it where it lives, and
automatic updates do the same at startup. Nothing is written through a link into another
installation (Homebrew, snap), where the server may not write, or where a custom binary from
Settings runs: that binary is never updated or replaced, and an install switches back from it.
With `--rclone-path` the binary is the operator's: Settings cannot change it and it is never
updated automatically.

## The rclone config

The server does not manage rclone's configuration file. It never picks a path for it, never
creates it and never passes one to the daemon: rclone resolves its own config, the way it does on
a command line.

The daemon inherits the server's environment, so rclone's own variables are how you steer it:

| Variable | What it does |
| --- | --- |
| `RCLONE_CONFIG` | the config file to use, absolutely |
| `XDG_CONFIG_HOME` | the config *directory*: `<it>/rclone/rclone.conf` |
| `RCLONE_CONFIG_PASS` | the password for an encrypted config |
| `RCLONE_PASSWORD_COMMAND` | a command that prints that password |

An encrypted config needs its password in the environment: the daemon has no terminal to ask at,
so without one rclone refuses every request with `unable to decrypt configuration ... set
RCLONE_CONFIG_PASS to your configuration password`.

Set none of them and rclone uses the first config file that already exists — `XDG_CONFIG_HOME`,
then `~/.config/rclone/rclone.conf`, then `~/.rclone.conf` — creating
`~/.config/rclone/rclone.conf` when there is none.

The image sets `XDG_CONFIG_HOME=/config`, so the config is `/config/rclone/rclone.conf` on its own
volume, the same place rclone's own image keeps it. Mount your host config there
(`-v ~/.config/rclone:/config/rclone`) and a terminal `rclone` and this server share one set of
remotes. Because the config lives outside the data directory, `--clear` does not touch it.

## Development

```sh
npm --prefix frontend ci
npm --prefix frontend run dev          # Vite on :1420
cargo run -- serve --dev-proxy http://localhost:1420 --email admin@localhost --password rclone-dev
```

`cargo test` covers the Rust side; `npm --prefix frontend run test:e2e` runs Playwright against a
debug binary and a real rclone daemon (`cargo build` and `npm --prefix frontend run build` first).
