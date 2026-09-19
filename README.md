# Rclone UI Server

A web interface for [rclone](https://rclone.org): remotes, transfers, mounts, schedules and
notifications, served to a browser. One binary runs the HTTP API, the pages and rclone itself.

Licensed under Apache-2.0.

## Run it

```sh
docker run -d --name rclone-ui \
  -p 5573:5573 \
  -e RCLONE_CLOUD_PASSWORD=change-me \
  -v rclone-ui:/data \
  ghcr.io/rclone-ui/rclone-ui-server
```

Open <http://localhost:5573> and sign in as `admin@localhost` with that password. The pair seeds
the owner account on the first start and is ignored once accounts exist; more accounts are added
under Settings › Team.

Mounting needs FUSE in the container:

```sh
--device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined
```

and a bind mount with `:rshared` propagation for the mount to appear on the host. Without
`/dev/fuse` the server reports that it cannot mount, hides the mount settings and skips any
remote set to mount on start, with one line in the log saying so — everything else works.

Without Docker, run the binary from the releases page: `rclone-ui-server serve`. Under systemd or
launchd a self-update exits with code 3 and expects the supervisor to start it again.

## Configuration

Every flag has an environment variable.

| Flag | Variable | Default |
| --- | --- | --- |
| `--bind` | `RCLONE_CLOUD_BIND` | `127.0.0.1:5573` |
| `--password` | `RCLONE_CLOUD_PASSWORD` | required |
| `--email` | `RCLONE_CLOUD_EMAIL` | `admin@localhost` |
| `--data-dir` | `RCLONE_CLOUD_DATA_DIR` | the platform's local data dir + `com.rclone.cloud` |
| `--rclone-path` | `RCLONE_CLOUD_RCLONE_PATH` | the stored, system or downloaded binary |
| `--rclone-url` | `RCLONE_CLOUD_RCLONE_URL` | unset; manage the daemon instead |
| `--verbose-rclone` | `RCLONE_CLOUD_VERBOSE_RCLONE` | off |
| `--clear` | `RCLONE_CLOUD_CLEAR` | off |

Anything but loopback needs a password, and `--clear` empties the data directory before starting.

## Data

Everything persistent lives in the data directory: accounts (`state/team.json`), settings
(`state/`), rclone configs and binaries, schedules and their run history, the transfer ledger,
notification targets and SMTP settings, and the log file. Back up that directory.

Scheduled tasks fire from the server's own minute ticker, so no cron or Task Scheduler entry is
needed; a task runs inside the server, on the rclone daemon it is already running, and each run
shows up on the Transfers page like any other transfer.

## Development

```sh
npm --prefix frontend ci
npm --prefix frontend run dev          # Vite on :1420
cargo run -- serve --dev-proxy http://localhost:1420 --password rclone
```

`cargo test` covers the Rust side; `npm --prefix frontend run test:e2e` runs Playwright against a
debug binary and a real rclone daemon (`cargo build` and `npm --prefix frontend run build` first).
