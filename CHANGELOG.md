# Changelog

Everything on the `server-split` branch relative to `main` (`83bc9c6`, "update README").
The work is uncommitted at the time of writing: 412 tracked files changed (+33,517 / −18,233),
of which 156 are pure renames carrying no line changes, almost all from collecting the frontend
into `src-frontend/`. Plus the new untracked files listed in their sections below.

## Highlights

- One server, one API, one orchestrator: `rclone-ui-server` serves the frontend and answers its
  API, and embeds the Tauri-free core that runs rclone. The desktop app is now a thin shell that
  starts that server on loopback and opens native windows at its URLs; a browser deployment runs
  the server binary alone.
- New product: Rclone UI in a browser, from a headless machine or a container (Docker image,
  signed release binaries for Linux/macOS/Windows, self-update, start-at-login).
- The pages no longer import Tauri anywhere. A single platform layer (`lib/api/`) speaks HTTP and
  WebSocket to whichever server served the page, and a build check enforces it.
- Persisted settings moved from per-window `tauri-plugin-store` files to server-owned, revisioned
  JSON documents with conflict detection and cross-window refresh.
- New Metadata option section on every operation that supports rclone's metadata flags, with an
  editor for `metadata_mapper` at the top of the section: rules instead of a program nobody has
  written. The Wizard asks whether metadata comes along, and takes the same rules.
- Transfers are recorded by the app, not read back from rclone: the server starts them, watches
  them with no page open and writes what happened to append-only files, so a transfer lists the
  moment it starts, scheduled runs list too, and all of it survives a restart. rclone is asked
  for the live numbers of what is running and nothing else.
- Fifteen bugs found and fixed in a file-by-file review, each backed by a test.
- Test suites added: Rust unit tests in the core and server, and a Playwright end-to-end suite
  against a real server and a real rclone.

## New: `rclone-ui-server`

- `src-server/` is a library plus a binary. `serve(listener, ServeOpts, Hooks) -> Handle`; the host
  then calls `handle.start_lifecycle`. `Hooks::standalone()` is the browser server's set (never
  prompts, self-updates from the release manifest, registers a login item, toasts through
  notify-rust, exits or relaunches the process).
- CLI: `rclone-ui-server serve` with `--bind`, `--password` (required), `--email`, `--data-dir`, `--local-data-dir`,
  `--rclone-path`, `--rclone-url <existing rcd>`, `--no-automount`, `--verbose-rclone`,
  `--dev-proxy`, `--clear`; every flag has an `RCLONE_UI_*` environment variable. `--clear`
  empties the data and local data directories before anything is opened (accounts, hosts,
  settings, schedules, notification targets, rclone configs, downloaded binaries; the
  directories themselves stay) and seeds the owner again; it refuses a filesystem root or the
  home directory (`AppDirs::clear` in `src-shared/src/appdirs.rs`).
- `src-server` has an `embed` cargo feature (rust-embed's `debug-embed`) for debug binaries built
  for another machine with cargo-zigbuild or cargo-xwin; plain debug builds keep reading `dist/`
  from disk. `list-commands` prints every
  RPC name. `run-task …` is the same headless scheduler runner the desktop binary has.
- Routes: `/__boot` (token → cookie), `/api/login|logout|session`, `/api/status`,
  `/api/capabilities`, `POST /api/rpc/{name}`, `POST /api/native/{name}`,
  `GET/PATCH/PUT /api/state/{doc}`, `ANY /api/rc/{host}/{*path}` (streaming reverse proxy with the
  daemon's credentials injected), `GET /api/dl/{token}` (short-lived signed download links),
  `POST /api/proxy` (allow-listed third-party fetch, currently only the Filen gateway),
  `GET /api/ws`, and the embedded `dist/` with the boot script injected at the
  `<!-- rclone-ui:server-inject -->` marker.
- Accounts (`src-server/src/team.rs`): the server signs people in by email and password.
  `--password` / `RCLONE_UI_PASSWORD` is mandatory and seeds the owner account on the first start
  (email from `--email` / `RCLONE_UI_EMAIL`, default `admin@localhost`); once `state/team.json`
  exists the flag is ignored. Roles: the owner (cannot be removed, demoted or reset by others),
  admins (add and remove members, change roles, reset passwords) and members. `team_*` RPCs
  carry the caller's account from the session; replies never include hashes. The desktop keeps
  its per-launch token. WebSocket upgrades are checked for same origin; RPC and native calls
  require the `X-RcloneUI-Session` header.
- WebSocket: one socket per page, `hello`/`ready`/`ping`/`pong`, `stream` and `stream_end` frames
  for streaming commands (buffered for two minutes across a reconnect), and every bus event.
- The embedded server's port is derived from the data directory so web storage survives
  relaunches, with an ephemeral port as the fallback.
- Standalone logging: stderr plus `<log dir>/rclone-ui-server.log`, which starts over once it
  reaches 10 MB (the full file is deleted, no `.old` copy, the desktop plugin's rule), with the
  pages' forwarded console at trace level (`src-server/src/logging.rs`, untracked). A unit test
  covers the rollover.
- Self-update reads `server-latest.json` (`server-<os>-<arch>` keys) and verifies the minisign
  signature with the desktop updater's public key before replacing the running binary. Under
  systemd or launchd a relaunch exits with code 3 and lets the supervisor restart the process.
- Start at login: a systemd user unit on Linux, a LaunchAgent on macOS, the Run key on Windows.
- The mobile-pairing tunnel (cloudflared quick tunnel) is owned by the server; the pairing payload
  now carries the managed daemon's RC credentials.
- Capabilities tell the pages what the host can do: `window` and `deepLink` are desktop-only;
  `updater`, `autostart`, `processExit` and `osNotifications` are off in containers; `mount`
  is off only on Windows without WinFsp.
- `Dockerfile` (multi-stage: Node build, Rust build of only `src-shared` + `src-server`, slim
  Debian runtime with fuse3, tini and the official rclone binary) and `.dockerignore`.
- README: a "Run Rclone UI itself in a browser" section with Docker and bare-machine usage.

## Architecture: the Rust workspace

- Root `Cargo.toml` is now a workspace (`src-shared`, `src-server`, `src-tauri`) with shared
  dependency versions; `Cargo.lock` and `target/` moved to the repository root.
- `src-shared/` (`rclone_ui_shared`) is the Tauri-free core. Moved here from `src-tauri`:
  `zookeeper.rs` (binary management, downloads, PATH integration, config sync), `local_fs.rs`,
  the whole `scheduler/` (cron conversion, job files, history and locks, crontab/launchd/schtasks
  backends, the headless runner) and `notifications/` (catalog, targets store, webhook dispatch,
  OS toast).
- New in the core: `appdirs.rs` (data roots with `RCLONE_UI_DATA_DIR` /
  `RCLONE_UI_LOCAL_DATA_DIR` overrides), `bus.rs` (in-process broadcast bus), `ctx.rs`, `rt.rs`
  (`block_on` / `spawn_blocking` usable from a worker, the blocking pool or a plain thread),
  `sink.rs` (typed streaming results), `rc.rs` (RC client), `platform.rs` (Flatpak gate, process
  kill), `state_files.rs` (the state store), `scheduler/mode.rs` and `scheduler/ticker.rs`.
- `commands/mod.rs` declares every portable command once in `for_each_command!`; `dispatch` runs
  them by wire name, with `sync` bodies on the blocking pool, `async` bodies awaited and `stream`
  bodies given a `Sink`. Commands take a `Ctx`, never an `AppHandle`.
- The orchestrator (`src-shared/src/lifecycle/`, `Supervisor`) replaces the desktop's 925-line
  TypeScript `main.ts`: binary resolution and auto-update, config resolution (default config,
  encrypted configs, synced configs), an authenticated `rclone rcd` on an ephemeral port, restart
  coalescing with page-supplied overrides, crash backoff, startup mounts, the
  license check and free-tier cap, scheduler reconcile, and the current-host check. Boot-time
  questions go through one `Interaction` trait: the desktop answers with native dialogs, the
  server with a fixed policy. Phases are published as `lifecycle.phase`.
- Transfers (`src-shared/src/transfers/`): `ledger.rs` is the files and `service.rs` the server's
  side of them. One append-only JSONL per writer under `<data dir>/transfers/` —
  `hosts/<hostId>.jsonl` by the server's `TransferService`, `tasks/<taskId>.jsonl` by `run-task`
  under its run lock — in the scheduler history's style (`started` / `finished` lines, fsynced,
  one `write_all` per line), plus `details/<id>.json`: the request the transfer was started
  with, written as it starts, then at the end rclone's last `job/status`, the files it moved and
  the files that **failed**. Those are gathered while the transfer runs (`merge_failed`, one
  `core/transferred` read per 5 s tick): rclone only remembers a job's last 100 files, so a long
  transfer's early failures are gone from its list by the end. At most 1,000 are kept
  (`MAX_FAILED`). A transfer that retries another's failures says so
  (`retryOf`). One writer per file is what makes compaction safe:
  past 1 MB a file is folded and rewritten to its newest 500 transfers (a running one always
  stays) and the dropped ones lose their details. A transfer has an id of its own; rclone's
  `jobid` and the daemon's pid are fields of it. Its end is `completed`, `failed`, `stopped`,
  `interrupted` (its daemon went away) or `unknown` (it ended unwatched and rclone forgot).
  The service lives in the server's state, not in the `Supervisor`, so it runs in
  external-daemon mode too, which had no job watching and therefore no job notifications at all.
  `start` posts the page's request (`/job/batch`, `/sync/sync`, `/sync/bisync` and nothing else),
  records, watches, and answers with the launch's early failure if there is one; `stop` stops
  the group and records `stopped`; a 5 s tick reads `job/status` and, at the end, snapshots
  `core/stats` and `core/transferred` for the group before sending the `job.*` webhook. The
  supervisor tells it when the managed daemon goes down (`daemon_stopped`: what ran on it is
  `interrupted`); at startup `recover` closes what a managed daemon left open and watches again
  what a daemon it does not own may still be running, believing a job id only once `core/pid`
  matches the recorded one. Every line written is a `transfers.changed {hostId, id}` on the bus.
  `transfers_start` and `transfers_stop` are server RPCs; `transfers_list` and
  `transfers_detail` are plain reads in the command table. `lifecycle/watcher.rs` is gone.
- The scheduled runner records each job it runs as a transfer carrying `taskId`, `taskName` and
  `runId`, with the totals it already read widened by `totalBytes` and `checks`, and closes what
  a killed run left open when it next holds the lock. A job spec carries the task's `sources`
  and `destination` for that; job files from before are read off their requests
  (`transfer_paths`). A scheduled transfer whose run lock nobody holds reads as interrupted.
- Startup mounts run in Rust for both products, with the same option re-keying, source probing
  and retry policy the desktop had in TypeScript.
- Email is a notification provider, in the place the "Telegram (botless)" placeholder card held
  (that card is gone; the Telegram bot provider and the WhatsApp placeholder stay). An email
  target is a target like the others — a name, its recipients (one address or several,
  separated by commas, kept as the target's `url`), its events, Enabled, Send Test, and a
  delivery record — and goes out through the SMTP settings, read at the moment of sending
  (`notifications/smtp.rs`, `lettre` on the same rustls stack reqwest uses) by whatever
  dispatches: the server, or the headless runner with no page open. One plain-text message per
  event: the subject is the event's title, the body its text and a line naming the app and
  version. Without a saved server the target records why (`SMTP is not set up…`, the card's
  warning chip) and the drawer says so up front with a button to the SMTP settings; a 4xx or a
  dropped connection is retried once, a 5xx is not. The SMTP screen is on both products (below).
- CI guards that `src-shared` and `src-server` never pull in `tauri`, `gtk`, `webkit2gtk`, `wry`,
  `tao`, `glib` or `gdk`.

## Desktop app (`src-tauri`)

- The log plugin keeps `Rclone UI.log` up to 10 MB and then starts it over (its default was a
  40 KB cap with the same delete-and-restart rule, which left bug reports with almost nothing);
  the server's own logger shares the constant.
- `shell/boot.rs` is the boot chain: Flatpak permission gate → embedded server (token auth,
  deterministic port) → toolbar window, shortcut, tray, deep links → updater policy → lifecycle →
  startup window.
- `shell/native_bridge.rs` answers `/api/native/*` (window open/focus/hide/close/position/drag/
  maximize/theme/lock, toolbar show, shortcut); `shell/interaction.rs` holds the native boot
  dialogs and the text prompt for a config password; `shell/tray.rs`, `shell/updater.rs`,
  `shell/startup.rs` and `shell/deeplink.rs` replace what `main.ts`, `lib/tray.ts`,
  `lib/window.ts` and `lib/deep.ts` did.
- Windows are created by `common/window.rs` and `common/shortcut.rs` from boot URLs with an
  initialization script that sets `window.__RCLONE_UI_WINDOW__`; their focus, blur, move and theme
  events are published on the bus.
- Quit and relaunch always run the server's quit flow (active-transfers check, tunnel, daemon,
  then `Hooks.on_quit`); the exit-requested handler prevents exit unless that flow set the flag.
- `tauri.conf.json` declares no windows, `withGlobalTauri: false` and a stub `frontendDist`
  (`src-tauri/empty-dist/`); `capabilities/default.json` and the hidden `tray.html` window are
  gone. Dropped plugins: fs, opener, http, store, process, os. Direct dependencies now provided
  by the core: zip, machine-uid, sysinfo, flate2, tar, sha2, dirs, notify-rust, uuid, libc,
  winreg, windows-sys. Dropped outright: zbus, x11rb.

## Frontend

Every path in this section is relative to `src-frontend/` (see Repository layout below).

- `lib/api/` is the only platform layer: `rpc.ts` (RPC envelope, byte uploads, streams), `ws.ts`,
  `events.ts`, `state.ts` (the zustand storage adapter), `rc.ts`, `fs.ts`, `os.ts` and `paths.ts`
  (synchronous, from the boot script), `dialog.ts` and `dialogs.ts`, `windows.ts`, `native.ts`,
  `shell.ts`, `clipboard.ts`, `app.ts`, `host.tsx` (`useCapabilities`), `lifecycle.tsx`, `log.ts`,
  `navigation.ts`, `boot.ts`.
- Removed: `main.ts`, `lib/rclone/init.ts`, `lib/tray.ts`, `lib/window.ts`, `lib/deep.ts`,
  `lib/events.ts`, `lib/cloudflared/*`, `store/lib.ts`, `store/memory.ts`, `public/tray.html`,
  `scripts/buildExternal.js`, and every `@tauri-apps/*` package plus `tauri-plugin-sentry-api` and
  `use-broadcast-ts` from `package.json`.
- Job watching, notification-target reconcile, scheduler reconcile, boot-time license validation
  and host reachability checks left `lib/notifications.ts`, `lib/scheduler.ts`, `lib/license.ts`
  and `lib/hosts.ts` for Rust; transfers are started, watched and recorded by the server (see
  Transfers, below).
- A remote can be renamed from its edit drawer (Settings › Remotes › Edit Config, the Name field).
  rclone has no rename call, so `lib/rclone/rename.ts` renames the section header in the
  config file: the daemon says where the file is (`config/paths`) and reads and writes it
  through its own file endpoints, the same road for the app's daemon, an external one and a
  remote host (rclone re-reads a changed config; every parameter stays, OAuth tokens included).
  An encrypted config is refused with a message. Mount-on-start settings, favorites, the
  sidebar's first-seen time and scheduled
  tasks naming the remote follow it (tasks are re-registered). A clash or an invalid name is
  caught while typing. The Config section's editor (`ConfigEditDrawer`) now reads and writes
  the file through the daemon the same way (`lib/rclone/config-file.ts`); for the active
  config that is the file rclone reports it runs with, external and remote daemons included.
  Settings › Remotes has an Edit config file button that opens it on the daemon's file, with
  or without an app entry for it (the entry's label and password fields show only with one).
- One file road: every file the pages touch goes through rclone, where the files are
  (`lib/rclone/daemon-fs.ts`: stat, mkdir, purge and size over rc, a file's bytes through
  `--rc-serve`, writes through `operations/uploadfile`). The Commander lists local folders with
  `operations/list` like any remote and asks `operations/size` for each folder's total as a job,
  two at a time, stopped the moment you leave the listing (or the tab), so no walk of a big
  folder outlives its listing; a remote host now lists its own disk under
  Local, not the UI server's. Config files (create, import, export, delete, sync, validation),
  template exports and the FUSE check take the same road. The server's `fs_*` RPCs are down to
  `fs_read_tail` (the UI server's own log) and `src-shared/src/local_fs.rs`, the streamed local
  scanner, is gone.
- Templates hides its search and add bar until the first template exists; the empty state's
  button is the way in.
- Delete and Purge take several paths, as Copy and Move do (`MultiPathField` in place of
  `PathField`). Their arguments and request builders were always a list — one `job/batch` input
  per path — and only the page was one field, so a preset or a finished job carrying several
  silently kept the first. `MultiPathField` gained the `allowedKeys` and `showFiles` its
  single-path twin already had, which is what keeps Delete's picker to remotes and favourites and
  Purge's to folders. Delete's "supports Purge" tip shows for a single path only: it names a
  remote, and several have no one name.
- A template carries its paths as well as its flags (`Template.paths`, `lib/rclone/templatePaths.ts`).
  `SAVE AS TEMPLATE` keeps whatever the page is set to run on, the Add and Edit drawers offer the
  same path fields the operation pages use (`PathField`/`MultiPathField`, which gained an optional
  `labelPlacement` so their labels sit outside like the Name and Tags above them), the card shows
  `source → destination`, and the Wizard keeps the paths of a plan kept as a template. Applying one
  asks the question it always asked — the same "Add to Existing / Replace All" now answers for the
  paths too, merging appending sources and filling only an empty destination. **A template with no
  paths never clears the page's**, whichever button is pressed, which is every template saved
  before this. Sources are a list, because copy, move, delete and purge take several; the pages
  that take one say which they will use ("This template has 3 sources; sync uses the first").
- The Dashboard opens with a getting-started timeline (`src/pages/Dashboard/Onboarding.tsx`) in
  place of its inventory rows: Add a remote, Browse it in the Commander, Move some files, Add a
  team member, then an optional list pointing at Schedules, Notifications and Templates. Steps tick
  themselves off from the daemon's config and transfer stats, the team list and a Commander visit, and stay
  ticked (`onboarding` in `store/persisted.ts`); the optional rows show what is already set up.
  Dismiss brings the rows back for good.
- The trailing slash is spelling, not a signal. Whether a source is a file or a folder decides
  the endpoint (`sync/copy` or `operations/copyfile`, `operations/delete` or `deletefile`,
  Purge's "folders only", and whether filters may apply), and the only signal used to be a
  trailing separator the app wrote itself: the picker put one on every folder it handed out,
  and the Commander on every folder dropped. A folder typed by hand had none, so it went out as
  a file and rclone answered `is a directory not a file` (nothing copied; a Delete left the
  folder); a file typed with one was `is a file not a directory`. Now the start asks rclone
  what each source is — the `operations/stat` every start already made to say "does not
  exist", whose `IsDir` was thrown away — and the builders take its answer (`kinds`, keyed by
  the path as given; `lib/rclone/kinds.ts`, `describeSources`). A pure build with no answer
  reads the spelling as the only hint there is. The picker and the Commander add nothing any
  more; `remote:folder` and `remote:folder/` are one path, as they are to rclone. Purge, Sync
  and Bisync refuse a file by name ("… is a file; only folders can be purged", "… a sync needs
  a folder"). A scheduled task keeps what rclone said when it was saved (`ScheduledTask.kinds`)
  and its job file is rebuilt from that: a later re-registration (enable, a cron edit, a remote
  rename, which renames the keys too) may run under another active config, so it is not asked
  again; a task saved before this field reads its paths' spelling. The stat carries the
  operation's own `_config` (`configParamOf`), so nothing is built before the answer is in.
  Mount, Serve and Download are untouched (a folder always). Destinations are never stat'ed
  (a sync's may not exist yet). Verified on the real daemon that a root (`remote:`, `/`) stats
  as a folder like anything else.
- One path grammar, rclone's own (`src-frontend/lib/paths.ts`, a port of `fspath.Parse`;
  its twin `fs_info` in `src-shared/src/lifecycle/mounts.rs` for startup mounts). The app used
  to tell a remote path from a local one by the substring `:/`, which the file panel wrote into
  every path it handed out (`remote:/x`) and `getFsInfo` stripped again before rclone saw
  anything, so a hand-typed `remote:folder` was a local folder to the Commander's path bar
  (the panel listed the remote underneath and called it "Local"), and the leading slash the
  user typed was lost where it counts: on sftp `remote:/x` is the machine's `/x` and
  `remote:x` is under the login directory. Now a string is a remote path by its shape alone,
  as rclone reads it: no `:` is local, a separator before the first `:` is local, the prefix
  must fit rclone's name grammar (letters, digits, `_ . + @`, inner spaces and dashes), `,`
  opens connection-string parameters, and on a Windows host only a one-letter name is a drive.
  No remote list, no I/O: the one bit of context is whether the host is Windows. The path
  after the colon is verbatim: the fs root carries a leading slash (`sftp:/` + `var/www`, the
  shape `:local:/` + `tmp/x` always had; verified on the real local backend that a slash inside
  `remote` never escapes the root, so the root is the only place it can live), a bare
  `remote:` is a folder (it was sent as `copyfile` of a nameless file) and gets no slash it did
  not have, and `remote:` and `remote:/` stay two places up the breadcrumb (a `/` crumb marks
  the absolute root). The panel hands out `remote:name`, favorites keep the path as spelled,
  links open `?path=remote:`, and what is shown (the Wizard's sentence, tooltips, the toolbar)
  is what was typed. What rclone would refuse is said instead of sent, next to the field and
  on the start button ("Fix the source path"): a name it does not allow, unfinished
  connection options, an on-the-fly remote without its colon, and a Windows drive path on a
  host without drives (`C:\…`, which rclone reads there as a remote called `C`). Entering the
  panel's own location again after a refused path refreshes it. `:local:` is built in one
  place with an explicit root, so the six call sites that promoted a bare `:local:` to
  `:local:/` are gone; a picked folder's marker is `/` on a remote and the host's separator
  on a local path (it was the page server's, `\` on a Windows-served page). Paths saved by
  older versions are read as they are: a `remote:/x` the old panel wrote now means the
  absolute root, which is the same place on every backend that trims the slash and a different
  one on sftp-like backends; not migrated. No sftp server was at hand: the sftp meaning rests
  on rclone's source and on the local backend, which keeps the slash the same way.
  `lib/fs.ts` (an unreferenced `isRemotePath`) is gone; `retry.ts`'s `fsKey` keeps its own
  reader because it reads rclone's canonical *output* form (`gdrive{AbCdE}:`), which rclone's
  own parser refuses. A one-letter remote name is refused when a remote is created or renamed,
  on every host: rclone's rc `config/create` takes it (only its interactive `rclone config`
  refuses), and on Windows `c:path` is then the drive C, so the remote can never be named; a
  config file made on a Mac may be carried to a Windows machine, so the rule does not depend on
  where the app runs. One already in the config still parses as rclone parses it (a remote
  everywhere but Windows).
- The Wizard (`src/pages/Wizard/`, Overview › Wizard, browser only): plain questions in place
  of a form. What you want to do; what happens to the originals, or which way changes go, or how
  others will connect; where the files are and where they should go (the same path picker as the
  operation pages); for a copy, move, sync or bisync, whether the files' metadata comes along
  (no; yes; yes with changes, which opens the mapping panel on the step and waits for a whole
  rule, and reaches the page as its Metadata options — `metadata` on, and the mapper beside
  it); once or on a timer (presets, or the cron editor behind Custom, disabled with
  the reason where schedules cannot run); and whether to keep the settings as a template. The
  cards wear the operations' colours from their option accordions, on the icon tile and, once
  picked, on the border and focus ring. A
  sentence at the top reads the plan back as it fills in, and the last step lists every answer
  with a Change link. Its Open button hands the plan to the operation's page as a preset: the
  places filled in, the schedule already in the Schedule section (the start button reads Start
  and schedule), and a template saved under the chosen name when the operation starts. The
  Dashboard's Start panel points at it ("Not sure? Open Wizard").
- Operation presets (`lib/rclone/preset.ts`): an operation page can open with everything set,
  not only a source and a destination: the paths, every option group, the remote overrides, the
  schedule and a template to keep, carried in its URL as `?preset=` (base64url JSON). The pages
  read it through one hook (`src/components/operation/useOperationPreset.ts`), which also folds
  the toolbar's and the Commander's `initialSource`-style parameters into the same shape; the
  option groups seed from it in place of their defaults, and Reset options still goes back to
  the defaults.
- The path picker (the folder button next to every path field) renames and deletes rows in
  place, as the Commander does: the same hover buttons, name prompt and confirm, now from one
  hook (`src/components/navigator/useEntryActions.ts`) that both use. A renamed or deleted row
  leaves the picker's selection; `allowEdits={false}` on `PathSelector` keeps a picker to
  choosing only.
- The Commander's Favorites view carries the star and nothing else. A favourite is a bookmark
  held in the host document, not a folder being listed, so rename, download and delete would
  have reached past the list to the real path; they are off there, and dropping the bookmark is
  what a row does. One `isFavorites` in `src/components/navigator/FilePanel.tsx` gates the row
  actions, the read-only path bar and the hidden panel toolbar, which each tested
  `selectedRemote` for themselves. Those rows are labelled "(remote) name" and have no path bar
  over them, so hovering one puts the path it points at on a tooltip (`showFullPath` on
  `FileList`); every other listing already shows its path, and keeps the plain `title`.
- The Serve page asks for the listen address in a field of its own, between Type and the
  options. Every serve type needs one, and it used to live only as the `addr` flag inside the
  Serve options JSON. The field is that flag, not a copy of it: the JSON stays the value, the
  field reads it straight off the string (parsing lands a render later, which a controlled
  input cannot wait for) and writes back into it, so either side shows what the other typed and
  clearing the field removes the flag. The placeholder is rclone’s own default for the chosen
  type (`127.0.0.1:8080` for HTTP, `localhost:2022` for SFTP). The blocked start button now
  says “Specify an address to serve on” rather than pointing at the options. The type select
  lost its outside label for an inside one reading “Type”, so Source, Type and Address line up.
- Backend icons are named after the rclone type, which is what a configured remote carries, so
  every surface draws one the same way: `/icons/backends/${type}.png`. They used to be named
  after the backend's *prefix*, which the create and edit lists had but the sidebar, breadcrumb,
  Dashboard and remotes list did not — for the three backends whose type is not their prefix
  (`google cloud storage`, `google photos`, `oracleobjectstorage`) those four drew nothing.
  The three files were renamed to their types and the two lists now key off `Name`. Two of
  those names hold a space, which a request percent-encodes, and `static_files.rs` was looking
  the raw path up against keys that are real file names: it decodes first now (`asset_key`),
  and a path that could climb out of `dist/` takes the SPA fallback rather than a lookup, since
  a debug build reads the folder off disk. A missing asset answers 200 `text/html`, so this
  failed as an empty image rather than a 404.
- The Commander's row of hover icons sits in an 8rem column rather than 11rem. Two panels and
  their rails leave little for file names, and the icons never filled the width they had; Name
  is the `1fr`, so it takes what they gave up (`useNameColumnResize` in `FilePanel.tsx`). The
  icons overhang the column at that width, but into Last Modified’s trailing space: against the
  widest date the column can print there is still ~41px of clearance. Their gap went from
  `gap-1` to `gap-0.5` so that the fifth icon a public-link remote adds (Share) clears it too,
  by ~7px.
- OAuth logins that cannot get stuck (`lib/rclone/oauth.ts`, rclone 1.75's
  `config/oauthstatus` and `config/oauthstop`): a login somebody walked away from keeps rclone's
  auth server on its port, and the next one failed with "address already in use" ("Rclone Oauth
  Client is stuck, please restart the UI"). Every login (creating an OAuth remote, plain or
  interactive; the Reconnect dialog) now stops a running one first. Cancelling a creation, or
  closing its drawer, stops the login on the daemon and removes the half-written remote; the
  Cancel button reads "Cancel sign-in" while one runs. A login that *fails* rather than being
  cancelled now removes it too: rclone writes the config section before running the login, so a
  refused consent or a rejected token used to leave a remote with nothing behind it, which the
  Remotes page would then offer to reconnect. The non-interactive path was the only one that
  kept it — `createRemoteInteractive` had always cleaned up on any error — so the two paths now
  agree.
- The create drawer checks the name while it is typed, with `checkRemoteName` (`lib/rclone/
  rename.ts`) — the same check the rename field uses, so a name rclone would not accept is
  refused here too. Creating over an existing name used to overwrite it: rclone writes the
  section before running any login, so by the time anything failed the old settings were already
  gone and no cleanup could bring them back. The collision is now stopped before the call.
- rclone never opens the browser itself any more, on either product: every login passes
  `config_auth_no_browser` (an ephemeral key, never written to the config file), reads the link
  from `config/oauthstatus`, and offers it in a dialog — **Open in browser**, **Copy link**,
  **Cancel sign-in**. Copying re-asks instead of closing, so a link finished in another browser
  still has something to cancel it with; on the desktop this replaces a browser window opening by
  itself. One helper (`presentSignIn` in `lib/rclone/oauth.ts`) serves the create drawer, the
  interactive config flow and Reconnect. Its Cancel is routed back to the caller, so cancelling
  a creation takes the same path as the drawer's own Cancel and still removes the section rclone
  wrote before the login. The in-page message dialog grew an optional third button
  (`buttons.extra`) for this.
- Finishing a sign-in on another machine, for when the machine running rclone has no usable
  browser — the browser deployment's normal case. A fourth button, **Another machine**, hands
  over the *provider's* consent page rather than rclone's link: rclone's redirect address is its
  own loopback, so its link opened elsewhere reaches nothing. Approving there ends on a page that
  cannot load, whose address carries the code; pasted back, the server replays it to rclone here
  and the blocked call finishes. Two server RPCs do the parts a browser cannot
  (`src-server/src/server_rpcs.rs`): `oauth_auth_link` follows the `Location` of rclone's
  `/auth` to find the consent page, and `oauth_deliver_code` replays the code. Neither takes a
  URL from the page — both read the callback's origin and the login's `state` from the daemon's
  own `config/oauthstatus`, so there is no user-supplied fetch target, and the port is never
  hardcoded. A mismatched `state` is refused. The in-page dialog set gained a `handoff` kind
  (`lib/api/dialogs.ts`, `DialogHost.tsx`): a link shown with a Copy button that stays on screen
  while the answer is pasted, since a copy that silently failed would otherwise leave nothing.
  Verified against a real rclone: a code delivered by a different client is accepted, and
  following the `/auth` redirect does not consume the login.
- `MIN_RCLONE_VERSION` is 1.75.0, up from 1.70.0. The login now depends on `config/oauthstatus`
  for the link, which 1.75 added: with no browser opening and no status call there would be
  nothing to show. The Binary settings screen's "too old" mark and the release list it offers
  move with it.
- The Transfers page reads the server's record (`lib/api/transfers.ts`) and overlays rclone's
  live numbers on the rows that are running (`lib/transfers/live.ts`, the one file of it that
  calls rclone; `lib/transfers/rows.ts` merges the two, pure). The list refetches on
  `transfers.changed` and every 5 s (a scheduled run's lines come from another process); the live
  overlay polls at 2 s only while something runs here. A transfer still listing its remotes is a
  row that says "Preparing · N listed". Ended rows say how: Stopped at 40%, Interrupted, Outcome
  unknown. `lib/rclone/api.ts` keeps its builders, pre-flight checks and call sites; `startBatch`
  and the sync/bisync path end in one `transfersStart` in place of the rc call, the report to the
  watcher, the 1 s sleep and the status check, with no blind retry (a retried start whose reply
  was merely lost ran the transfer twice). Gone with it: `listTransfers`, `fetchJob`, the
  per-window `watchedJobs`/`dryRunJobs` maps, `unwatchJob`, `isDryRunJob`, `rememberJob`,
  `presetForJob`, `watchJobs` and `types/jobs.d.ts`.
- `TransferDetailsDrawer` (was `JobDetailsDrawer`) reads a transfer from one of two places and
  never both: one running on this client's daemon live from rclone, anything else from what the
  server kept (`transfers_detail`), with no rclone call — it used to poll three endpoints a
  second for finished jobs too. Reuse settings reads the record's `preset` (dry runs come back
  without `dry_run`, the Commander's copies and moves included); an interrupted transfer says to
  run it again and offers **Open Copy** (the Wizard's name for going to an operation's page with
  everything filled in), which opens its page as it was: copy and sync skip what already arrived.
- The Download page's URL download goes through the recorded start too (`startDownload`, a
  `/job/batch` of one `operations/copyurl`, operation `download`, the URL as its source): it is
  in Transfers, watched with no page open, notifies, and can be retried; a dead one is the
  START button's error, named by its file. It ran `operations/copyurl` on rclone directly,
  wrapped in three retries, so nothing recorded it and a start whose reply got lost downloaded
  twice; it is one attempt now, like every start. Declining to reconnect a remote is an answer
  there, not an error. Every start the app makes is recorded now; the quit and busy checks'
  look at rclone's files in flight is for a job put on the daemon by something else. Tested
  against real rclone with a local HTTP file server (the file arrives, the record says
  `download`; a 404 is `gone.txt: … 404` from the START button), and the Download page's own
  test reads its URL from the recorded start.
- The Dashboard counted every file the daemon touched as a transfer. Its transfers list came
  from the record already; its **Moved / Files / Errors** were still rclone's daemon-wide
  `core/stats`, and rclone accounts a file written through it as a transfer like any other
  (probed: one `operations/uploadfile` of `rclone.conf` is `transfers: 1` and an entry in
  `core/transferred`). So creating, editing, importing or exporting a config, renaming a remote,
  exporting templates, and the placeholder the Commander uploads to make an empty folder each
  read as "1 file moved" — and a failed one as an error. The figures are the record's now
  (`totalsOf`, `lib/transfers/rows.ts`, pure): the transfers that ended in the last 24 hours
  and the ones still running, which count as they go (the live read carries a job's files and
  errors; a row has `fileCount` and `errorCount`), dry runs left out. The window is said above
  them ("Transfers · last 24 hours"): it is one the page can know and a user can read, which
  "since this rclone daemon last restarted" was not. Scheduled runs are in them, which they
  never were. The same counter ticked off getting-started's **Move some files** for someone who
  had only saved a config file; that step goes by a transfer on record and nothing else. The
  throughput trace, the speed and "N files moving" stay the daemon's: they are about bytes
  moving right now, whatever moves them.
- The three things that review had looked at and left. (1) `transfers_list` read and parsed
  the host's file and every schedule's on every call, and every open page calls it every 5 s:
  a file is now parsed when it has changed and not otherwise (`ledger::entries_of`, keyed on
  its length and modification time; every write changes the length, and the look at the file
  comes before the read, so a parse is never served for a file that has moved on). The files
  fold on their own — a transfer's lines are all in one — and only the entries listed are
  copied out; a deleted schedule's parse is dropped. (2) A scheduled run read its files once,
  at the end, so a long run kept only the failures among its last 100 files; it gathers them
  as it polls, with the code the server uses (`Failed`, `merge_failed` and `keep_outcome` moved
  to `status.rs`), and its details carry `failed` like any other transfer's. (3) "Transfer
  started" went out the moment rclone took the job, a second before the launch check, so a
  wrong path announced a start, then a failure, then the START button's error. It is said once
  the launch has held; a launch that dies says only that it failed. That moved "started" next
  to the end of a transfer that is over within its first second, and turned up a race of its
  own: the ticker, on its own clock, could land inside the launch check, end the transfer and
  say "completed" before "started" had been said. A transfer is the launch's until its check
  is done (`Watched.launching`; the ticker's `due` set leaves it out, a stop still reaches
  it), and `start` gives "started" up to 3 s to be delivered before it records an end
  (`notify` returns its handle; notifications still go out side by side, so an endpoint that
  does not answer holds up nothing). Tested against a webhook receiver: a dead launch is heard
  as `job.failed` alone, and six starts back to back — between them a whole interval of the
  ticker — each as `job.started` then `job.completed`; with the launch rule off that test
  fails. The scheduled run is tested for real (`scheduler_register` + `scheduler_run_now` on
  the managed server, throttled, 120 files after one that fails at once): rclone's own list
  has forgotten the failure by the end, and the run has it.
- The transfers implementation, read end to end once storage and behaviour were settled. Five
  faults, each reachable: (1) `stop` said "un-watched first" and did the opposite — it stopped
  rclone, read the stats, then un-watched — so a tick landing in between recorded the stop as
  **failed** and sent a failure webhook; whatever ends a transfer now takes it out of the
  watched set first (`claim`) and whoever comes second writes nothing. (2) "Is this still the
  daemon that started it" was the daemon's pid, checked once, only for transfers found open at
  startup; pids repeat (in a container, after every restart) and a daemon replaced while we
  watched was never noticed, so `job N` was read off the new one: "not found" with the wrong
  explanation, or **another job's outcome** (the e2e test for it records `completed` with the
  check off). It is rclone's `executeId` now, from the start reply and every `job/status`, on
  every look; `Started.executeId` replaces `daemonPid`, the one change to the stored format
  (unreleased, no migration; a record without it is believed, as before). A job the daemon
  does not hold is `interrupted` when `job/list` shows another daemon, `unknown` only when it
  is the same one. (3) Every probe used the rc client's 300 s timeout in one sequential loop
  over all hosts, so one host that accepted a connection and never answered froze the
  recording of every other host's transfers; probes are bounded at 10 s and hosts are looked
  at side by side (a `JoinSet`, which also keeps a panic in one from ending the ticker).
  (4) Six failed ticks — 30 s — made a transfer `unknown` for good, throwing away one that was
  still running behind a VPN that dropped or a machine that slept; it is ten minutes out of
  reach now, by the clock, and any answer starts the wait over. (5) The scheduled runner read
  `job/status` for failures on its own, and still called a failed folder input `unknown:`;
  `status.rs` is the one reading (`verdict`, `outcome_of`, `failures_of`, `launch_error`,
  `run_error`) for the service, the runner and the START button. Weight taken out: the
  service's four id-keyed maps and its `ticking` flag are one map of `Watched`; `Entry` wraps
  `Started` (`flatten`) instead of repeating its fifteen fields, so a new field is added in
  one place, `open` is `fold` filtered, and an end is written one way (`ledger::finish`). On
  the wire an entry's `startedAt` is `ts` and what it lacks is absent rather than `null`;
  `sources` and `tags` are always written. Frontend: a row is its entry (no copied fields, no
  `row.entry`), `ENDED` words an end once for the list, the drawer and the Dashboard, the
  drawer's three 1 s queries are one `liveJob` (status read raw: through the client a finished
  job that failed throws), the Commander's bar follows the record for which of its transfers
  still run and reads an ended one's files from its details, `submit` takes an options object,
  and the rclone client's async twin, dead since starts moved to the server, is gone. Measured:
  67 fewer lines of non-test code across the files touched (Rust +11 with the new `status.rs`,
  frontend −78); the estimate going in was 200, and the fixes cost most of the difference.
- A transfer says where it came from: `tags` on its `started` line (`schedule`, `operation`,
  `commander`), a badge for each on its row in Transfers (failed rows included). The tag is now
  what makes a row a scheduled run — the Schedules redirect, no live numbers, no retry, the
  list reading an open run nobody holds as interrupted — where that used to be "it has a
  `taskId`"; the task and run ids stay, to say which schedule and which run to open. Only the
  scheduled runner writes `schedule`: the server drops it from what a page sends (`page_tags`,
  which also lowercases, dedupes and caps them). A retry carries the tags of what it retries.
  Records from before the field have no tags and no badge (the layout is unreleased, so there
  is no migration). The Commander's **download** goes through the same recorded start as its
  drops (`startBatch`, tagged `commander`, operation `download`) instead of calling rclone
  directly: it is in Transfers, is watched with no page open, notifies, and can be retried; it
  shows in the Commander's bar as before. The start functions return `{ id, jobid }`. (The
  Download page's URL download followed, below.)
- Everything that shows or counts transfers reads the record. Four places still built their idea
  of "the transfers" from rclone. The **Dashboard**'s panel was rclone's last six files and its
  files in flight: empty after any restart, blind to scheduled runs and to a transfer that was
  still listing, and labelled by a `job N` that repeats across daemons. It is now the record's
  newest six transfers (`useTransferRows`, the list the Transfers page is made of), the running
  ones with their progress and speed — so the live half shows transfers where it showed files.
  The **Commander**'s bar polled `core/stats` and `core/transferred` for every job the page had
  ever started, for as long as it stayed open, and by an id that means another job after a
  daemon restart; it now asks only while a job is unfinished (`liveJobState`), keeps a finished
  job's last files in the page, drops a job whose `executeId` changed, and counts unfinished
  jobs in its badge (so it says `1 active` while one is still listing). **Quitting** counted
  rclone's files in flight, so a transfer still listing or checking was killed without the
  question, and an external daemon's transfers — which a quit does not stop — were asked
  about; it now asks `TransferService::stopped_by_quit`. **Switching rclone** had the same
  blind spot and asked the current host though it restarts the local daemon; it reads the
  local record. Both still look at rclone's files in flight afterwards, for the one thing
  that is not recorded: the Download page's URL download, which keeps starting on rclone
  directly (the Commander's own download became a recorded transfer, see above).
  Every live read now lives in `lib/transfers/live.ts` (the drawer's three included), and a
  node-side test fails when a job endpoint turns up anywhere else.
- The drawer is laid out by what happened to the files: **Checking** and **Transferring** (live
  only, from the `core/stats` reply already polled), **Transferred** and **Failed**
  (`splitFiles`, `lib/transfers/details.ts`, pure). A section is there only when it holds
  something, and each folds behind a small chevron beside its title; which are folded is kept by
  the drawer, so a live section that empties for a second comes back as it was left. There is no
  Listing section: rclone reports a count for that (`listed`) and no names, and the count is
  what the drawer says while nothing has a record yet (`Preparing · 1,234 entries listed`). A
  failed file's row carries rclone's whole error. The box at the top holds only the errors that
  are no file's (`generalErrors`): rclone reports a folder's error, and a sync's, as the last
  error it met, which is word for word the error of a file whose row already shows it, so those
  are left out (exact match only — a miss repeats an error, it never hides one); an input that
  never became a file (`missing.txt: object not found`) stays, named by its input. It is text,
  not the JSON dump it was, and the record's own "1 of 2 operations failed" is no longer shown
  (it still words the notification). The header's buttons explain themselves on hover (Retry
  failed: "Choose failed files to retry"; Reuse settings: "Open Copy with these settings"), and
  the drawer's close button is the header's own, after them, in place of HeroUI's.
- Failed files can be retried (`lib/transfers/retry.ts`, pure; `TransferRetryDrawer`). A transfer
  that ended with failures offers **Retry failed · N** in its drawer, which opens a second drawer
  listing only what failed — a virtualized multi-select list, everything ticked to begin with,
  Select all / none above it — and **Retry N selected** starts one new transfer of exactly the
  selection: one file, some, or all. A file that failed inside a folder copy is retried as an
  `operations/copyfile` (`movefile` for a move) between its folder's own ends with the folder's
  `_config` and no `_filter`; an input that failed as a whole (a file that was not there, a
  folder that never got going) is retried as it was; a sync's failed files are copied, never the
  sync re-run with a filter (with `delete_excluded` that deletes); bisync offers nothing (running
  it again is the answer there). With several folders a file is matched to its own through a
  normalised fs key, because rclone reports a file's `srcFs` in its canonical form
  (`gdrive{AbCdE}:` for `gdrive,chunk_size=8M:`), and one that matches none is not guessed at.
  The retry keeps the original's operation, destination, settings and dry-run flag, and the two
  point at each other in their drawers (`Retry of #6`, `Retried as #12`). Errors are shown by
  their reason (rclone leads with the paths and ends with what went wrong; the whole text is on
  hover), long paths give way from their folders and never from the file's name. The list is
  what was recorded and nothing more: no note about what rclone may have forgotten, no second
  way to retry. Only for transfers the app started itself and that have ended: a
  scheduled run's request is not kept, and which inputs failed is not known before the end. It
  replaces a per-row retry that only worked for one shape, a failed `copyfile` input.
- A scheduled run's row carries a Scheduled chip and opens its schedule
  (`/schedules?task=<id>&run=<runId>`): a new tab in a browser, a window of its own on the
  desktop (`openWindow`'s `newTab`). The Schedules page opens that task's drawer with the run
  marked in its history. A desktop window that is already open is only focused, so the shell now
  puts the route it was asked for on the bus (`window.route {label, route}`, in every `open_*` of
  `src-tauri/common/window.rs`) and the page follows it. A run whose schedule was deleted opens
  the Transfers drawer instead, with what the record kept.
- Settings › Team (`src/pages/Settings/TeamSection.tsx`, browser only): the members list with
  roles, an Add member drawer for admins, a row menu (Make admin/member, Reset password, Remove),
  and Change email / Change password on your own row (`lib/team.ts`, `lib/api/session.ts`). The
  login page asks for email and password on a frosted card, titled Login, with
  the app icon drifting corner to corner behind it like a DVD player's logo (rclone-web's login,
  adapted; still under `prefers-reduced-motion`).
- Browser mode: `src/layouts/shell/` nests the same pages that the desktop opens as native
  windows in a black frame: a site header (the app icon, which turns into the sidebar toggle on hover; the
  breadcrumb; a cog for the tab's own settings, Sign out) and a sidebar with labelled zones
  (Overview with the Dashboard, the Wizard, Commander, Transfers, Schedules and Templates,
  the last wearing the same icon as the operation footers’ templates button (which now names
  itself on hover like the rest of that bar, and carries the name for assistive tech too);
  Operations;
  Remotes: the five newest from `config/listremotes`, newest
  by when the host first listed them, then All remotes with the count; Settings with
  Notifications, Rclone and Team). The sidebar collapses to a 56px icon rail with
  right-hand tooltips, remembers that choice, and collapses by itself on the Commander (and stays so until toggled); the seam
  between sidebar and page is a hover-lit rail that toggles it on click. The operation footers'
  "Run another command" launcher (`CommandsDropdown`) is desktop-only, the sidebar covers it. A remote in
  the sidebar opens it in the Commander's right panel. Page text can be selected in a tab, as on
  any web page (the desktop keeps its no-selection feel); the header and sidebar stay
  unselectable. The settings sections are routes there
  (`/settings/:section?`, `/remotes`, `src/pages/Settings/SectionPage.tsx`; the old `?tab=` links
  redirect) behind the same pin gate as the desktop window (`SettingsGate.tsx`, extracted from
  the tabbed page, which the desktop keeps). The header's cog (`src/layouts/shell/AppearanceMenu.tsx`,
  browser only) sets the theme and shows the language picker (English only, other choices say
  "Coming soon"); the Commander's bar carries a second cog
  (`src/components/navigator/PlacesMenu.tsx`, both products) that switches disks and folders in
  and out of both places sidebars (`hiddenLocalPaths` in the app document);
  a browser-only Rclone section (`src/pages/Settings/RcloneSection.tsx`) is the binary settings
  and the proxy settings on one screen, so Binary, Proxy and Hosts keep their routes but are not
  listed in the browser's sidebar. A settings group now takes its shape from its caller
  (`SettingsGroup.tsx`, `native` | `web`): the desktop's right-aligned label against a 3/5 field,
  or a card with its title above full-width controls for a wide tab (where the proxy URL and its
  ignored hosts are one card rather than two, the pair the desktop keeps). The browser also offers
  the newest three rclone releases to download rather than the desktop's twenty
  (`releasesShown` in `lib/rclone/constants.ts`); on both products a Load more button under the
  version list asks for ten more, and goes away when fewer come back than were asked for.
  The SMTP section (`src/pages/Settings/SmtpSection.tsx`, both products: a tab in the desktop's
  Settings window, a screen in the browser) is the mail server the Email notifications go
  through: server, credentials and sender fields, Save, and a test message to an address (the
  signed-in account's, when there is one). The settings are the server's own file
  (`notifications/smtp.json`, mode 0600, `src-shared/src/notifications/smtp.rs`), never a state
  document; a page gets everything back but the password, and only that one is saved is said
  (an empty password field keeps it, an empty username drops it, an empty host clears the file);
  `src/pages/Dashboard.tsx` replaces `Home`
  (live throughput trace, remotes, mounts, serves, recent jobs, schedules, lifecycle state);
  `src/pages/Login.tsx` for password-protected servers; `src/components/OperationGrid.tsx` and
  `src/components/EmptyState.tsx` (untracked). `Toolbar` and `Startup` exist only as native
  windows.
- Browser-tab differences live in `lib/api`, not in pages: dialogs, prompts and file pickers are
  rendered in the page by `src/components/DialogHost.tsx` on both products; toasts are in-page;
  "open" or "reveal" a path shows its location on the server; opening a window becomes a route.
  `html.browser` scopes the CSS that fits viewport-sized pages into the Shell's content column,
  and the operation footer floats as an island only in wide layouts. The footer's documentation
  button is the same difference: a native window has nowhere to open a page, so it keeps its
  full-screen sheet of prose, while a tab gets a link to that command's page on rclone.org
  (`rcloneDocsUrl` in `lib/rclone/constants.ts`; `copyurl` for Download).
- Desktop-only UI is gated with `useCapabilities()` (startup screen toggle, toolbar shortcut,
  tray theme, Mobile tab, auto-mount when there is no FUSE).
- The tab icon is the rclone mark, traced from the provider icon into `public/favicon.svg`
  (one lobe turned twice about the trefoil's centre) and carrying its own
  `prefers-color-scheme` rule: white on a dark tab strip, the logo's blue on a light one, where
  white would be invisible. `public/favicon.png` stays as the white fallback for browsers
  without SVG favicons and is declared first, since a browser takes the last icon it supports.
  `index.html` no longer ships Vite's default `vite.svg`.
- `index.html` reads the theme and capabilities from the injected boot payload for a correct
  first paint; `setupDragRegions.ts` uses `data-drag-region` and asks the shell to start dragging.
- Every page's console is forwarded to the host's log file through the `log` RPC (the desktop's
  `Rclone UI.log`, the server's own file).
- The Metadata option section: all rclone flags tagged `Metadata` (`metadata`,
  `metadata_mapper` and the six `metadata_include/exclude/filter[_from]` rules) live only there,
  placed after Config on Copy, Move, Sync, Bisync, Delete, Mount, Serve, the auto-mount drawer and
  both template drawers. The section is split at request time into `_config` and
  `_filter.MetaRules`, in TypeScript (`mergeMetadataOptions`) and in Rust (`merge_metadata_options`
  for startup mounts); the host document gained `mountOnStart.metadataOptions`. Copy and Sync no
  longer show the `metadata` flag in their own sections, and template tag selects no longer offer
  a "metadata" tag.
- The metadata mapper, a panel at the top of the Metadata section while the `metadata_mapper`
  flag is there. rclone's flag takes a
  *program* — it runs one per file and directory copied, hands it the object as JSON on stdin and
  reads the metadata back on stdout — so the app supplies the program: its own binary, with a
  `metadata-map` subcommand handled before anything starts, exactly like `run-task`
  (`src-shared/src/metadata_mapper.rs`, four lines in each binary's `main`). Tapping the chip
  adds the flag and the panel appears under the section's title, above the JSON and the chips;
  tapping it again takes both away. The panel holds rules that map
  a field to another name, set one to a fixed value or drop it, plus whether fields no rule
  mentions survive, and writes them into the flag as each rule is completed — no Save: a row
  with a field still empty stays in the panel, pointed at once it is left. A hand edit of the
  JSON, a template or a preset shows up in the panel as rules. Both sides suggest the metadata
  fields their own backend declares
  (`operations/fsinfo` → `MetadataInfo.System`, read-only ones left out of the destination), and
  the operation's paths decide which backends those are. The flag is written as an
  argv array — `["…/Rclone UI", "metadata-map", "--map", "mtime=modified"]` — which is the only
  form rclone accepts for a `SpaceSepList` over the rc API, and the only one that survives the
  space in the macOS binary's path. Tapping the chip adds `metadata` alongside, because rclone
  never calls a mapper without it (undocumented, checked against 1.75), and `metadataOptionsProblem`
  holds the pair together afterwards: the options section marks itself invalid, and Copy, Move,
  Sync, Bisync, Delete, Mount and Serve refuse to start while a mapper sits there without it, as
  do the template drawers and the auto-mount drawer on save. A flag already pointing at somebody else's program is
  shown, not silently replaced, and the panel says so and offers to replace it; a mapping saved
  by an older install is
  adopted and re-pointed at the binary running now. Where a backend keeps a field behind an option
  of its own — Google Drive writes `owner` only when `metadata_owner` says so (it defaults to
  reading it), `permissions` only when `metadata_permissions` does (off by default), and OneDrive
  the same for `permissions` — the panel says so before the copy runs, naming the option and what
  it is set to. Nothing is hardcoded: the option is always named after the field, so the backend's
  own definitions (`config/providers`) are asked, and the value is resolved the way rclone resolves
  it — this run's per-remote override first, then the remote's saved config, then the default.
  The same panel is the Wizard's metadata step behind "Yes, with changes". New
  files:
  `src-frontend/lib/rclone/metadataMapper.ts` (the codec, with its own spec) and
  `src-frontend/src/components/MetadataMapper.tsx`; `paths.exe` joins the boot payload.
  Not checkable from a Mac: the Windows GUI-subsystem binary must still read the stdin and
  stdout rclone hands it.
- Path options in the remote form (`PATH_PICKER_FIELDS` in `RemoteField.tsx`: service account
  and credential files, certificates, key files, the cache backend's folders, webdav's
  `unix_socket`) open the file panel in the folder the field already points at instead of home;
  `PathSelector` now honours a local initial path for every caller, and takes a `mode`
  (`both`, `files`, `folders`) instead of `allowFiles`: a file picker no longer offers "PICK
  CURRENT FOLDER" or lets a folder row be ticked, so the rclone binary, config import and path
  options can only return a file.
- Wrapper remotes (alias, archive, cache, chunker, compress, crypt, hasher): the `remote` field
  in the create and edit drawers has a button that opens the file panel to pick the remote and
  path; the choice is normalised to rclone's `remote:path` form (`toWrappedRemote`).
- The file panel's `LOCAL_FS_EXTRA` allowed key: the home folder and its Desktop, Documents and
  Downloads shortcuts are listed only for callers that ask for them. Every existing surface does;
  the wrapper-remote picker shows remotes, disks and volumes only.
- One module decides what an rclone option `Type` means (`lib/rclone/optionTypes.ts`): the remote
  form, the options editor's hover presets and the template importer all read it. The remote form
  renders every option: bools as checkboxes, numeric types as number fields, closed lists
  (Tristate, `a|b|c` enums, `Exclusive` options) as a Select, options with rclone `Examples` or
  the shared size and duration presets as a suggestion list that keeps whatever is typed, and
  everything else as text, which rclone parses like its CLI wizard. Verified against a real
  `rclone rcd` for local, chunker, sftp, b2, s3, cloudinary, hasher, swift and combine: every
  typed or picked value reaches the config file unchanged and rclone builds the backend from it.
- Mount probes the FUSE layer per platform before mounting (`lib/rclone/mount.ts`).

## Persisted state

- One data directory. The app used to keep two roots, inherited from which Tauri path API each
  side of the old app reached for: settings and schedules under the platform's roaming data
  directory, binaries and configs under the local one. They are the same directory on macOS and
  Linux; on Windows they are `%APPDATA%` and `%LOCALAPPDATA%`, and the split put machine-bound
  state (absolute binary and config paths, job files, run logs) in the half that roams. There is
  now one root, the platform's local data directory plus `com.rclone.ui` (`DataDir` in
  `src-shared/src/datadir.rs`; the desktop takes Tauri's `app_local_data_dir`), with the same
  layout underneath: `state/`, `scheduler/`, `notifications/`, `rclone-versions/`, `bin/`,
  `configs/`, `cloudflared`, `logs/`. `--data-dir` / `RCLONE_UI_DATA_DIR` set it for both
  products; `--clear` empties it.
- A storage migration engine (`src-shared/src/storage.rs`). The directory's layout has a
  version, kept in `storage.json` at its root, and the desktop shell and the server bring it to
  the current one at startup, before anything is read or created under it: each step above the
  stored version runs in order and writes the marker after itself, so an interrupted migration
  resumes where it stopped. Steps are numbered functions in one table, take the environment
  (desktop or server) and report what they could not finish; a marker written by a newer build
  stops the start with a message. The three steps for what the released desktop app left
  behind: fold the old roaming root into the local one (only when the directory is the
  platform's default and the sibling carries what the old app wrote; an overridden `--data-dir`
  never pulls anything in; directories merge, an existing file is kept and the source
  reported), convert the `tauri-plugin-store` files (`store.json`,
  `hosts/<id>/store.json`, a zustand store as a JSON string inside a JSON file) into state
  documents and remove them, and move the single-slot `rclone` binary into
  `rclone-versions/v<version>/` after probing it. Readers know only the current layout: the
  state store's lazy conversion, the scheduler store reader's and the config resolver's
  fallbacks to the old files, and the binary resolver's mid-ladder adoption of the slot binary
  are gone, with the `adopt_legacy_rclone` command (no caller). Old layouts are referenced in
  the engine and nowhere else. The scheduled runner never migrates: it checks the version first
  and exits without writing anything when the directory is not at the version it reads.
- The server owns `<data dir>/state/app.json` and `state/hosts/<id>.json` as
  `{version, revision, state}`. Pages read the whole document and write only the top-level keys
  that changed with `If-Match: <revision>`; a stale write gets 409 with the current document and
  the page re-applies its keys once. Rust writers use `store.update` under the same lock. Every
  write publishes `state.changed {doc, revision, keys}` and open windows rehydrate.
- PATCH accepts `unset` so a cleared setting is actually deleted (see bug fixes).
- Layout 4 (`storage.rs`, step four) drops `recentJobs` from every host document: what a
  transfer was started with is kept with the transfer, under `transfers/`.

## Scheduler

- The server runs schedules from an in-process ticker (`scheduler/mode.rs`, `ticker.rs`) instead
  of an OS scheduler, and passes the mode to its `run-task` children through the environment.
- The GUI's resolved data roots are baked into every runner invocation, including launchd
  "Run now" (previously missing there).

## Security

- The managed rclone daemon listens on a random loopback port with random credentials instead of
  `localhost:5572` without auth; pages reach it only through the server's proxy.
- The desktop server only serves its own windows: a stray browser tab at that port gets 401.
- Passwords are stored as argon2id hashes; a failed sign-in answers after a flat 500 ms delay on
  top of the hash cost. Sessions resolve to the account on every request, so removing a member
  or resetting their password ends their sessions at once. Sessions are in memory: a server
  restart signs everyone out.
- Fixed: the API guard treated any path with an asset-like suffix (`.png`, `.js`, `.css`, `.svg`,
  `.ico`, `.wasm`, `.woff2`) as a public bundle file, including `/api/rc/<host>/[fs]/…/photo.png`
  (served with the daemon's credentials, no session) and `PUT /api/state/hosts/x.png`. The suffix
  test now never applies under `/api/`.

## Bug fixes

The review in `__review__/V_BUGS.md` (ten findings and nine follow-ups) is fixed here, each with
a test where one is feasible:

- Switching hosts carried the previous host's state along (`store/host.ts`): hydration merged
  the new host's document over whatever was loaded before, so a document that lacked a key kept
  the other host's value and persisted it on its next write. Hydration now starts from the
  defaults. A page test switches to a second host and reads its document.
- A relaunch or a login-item start repeated `--clear`: both forwarded every argument and the
  autostart unit saved `RCLONE_UI_CLEAR` too. One-shot flags are dropped from restart
  invocations (`restart_args` in `src-server/src/lib.rs`), with unit tests.
- A removed member's WebSocket kept receiving events, tunnel credentials included. Sockets are
  bound to the account that opened them and close when it is revoked (removal, an admin's
  password reset). A team-server test removes a member with a socket open.
- A scheduled task on a config created through "Sync Config" failed before running: the
  runner's resolver ignored the entry's external folder. One resolver serves the lifecycle and
  the runner (`storeread::resolve_config_path`), with a unit test.
- A new transfer stayed out of the Transfers list for seconds. The list was built from rclone's
  files in flight (`core/stats` `transferring[]`/`checking[]`, `core/transferred`), and a job has
  none while rclone opens and lists its remotes: against a remote throttled to one request a
  second rclone knew the job after 22 ms and those arrays stayed empty for 3,021 ms. The page
  also stopped polling when its first fetch came back empty, so the row then waited for a focus
  or a refresh. The list is the server's record now and a transfer is in it from its first line.
- Transfers disappeared when the server (and with it the managed daemon) restarted, scheduled
  runs never appeared at all (they run on a private daemon), and a job was identified by
  rclone's number alone, which starts over with every daemon and collides across hosts. A
  transfer has its own id and its own record; a server test restarts the process and reads the
  finished transfer back with its totals and files.
- A folder that failed to start was named "unknown" in the START button's error (the message
  names an input by its `srcRemote`, which a folder has none of); it is named by its source. A
  long path in an in-page dialog ran out of the box, having no space to break at
  (`DialogHost`); it wraps anywhere.
- A dry run was only known to the window that started it (a module-level map), so the Transfers
  window on the desktop listed it as a real transfer. It is a field of the record.
- Download: a metadata lookup that failed for a new URL left the previous URL's resolved
  address in place, and that was what got downloaded. Metadata is bound to the URL it was
  resolved for, cleared on change, and a failed lookup falls back to the field. A page test
  intercepts the lookup and the copy request.
- Two pages creating the same state document overwrote each other: the first write was an
  unconditional PUT. A creation now carries `If-Match` (0 for a new document); the server answers
  409 with the winner's document and the loser adds only the keys the winner lacks. Tested raw
  and through two storage instances.
- An old WebSocket connection could detach its replacement's stream route; attachments now carry
  a generation and a detach only clears its own (unit test).
- A present but unparsable `If-Match` was treated as no precondition; it is now a 400. A
  malformed job report was accepted as empty; `transfers_start` refuses one (both tested).
- Readiness polling could exceed its 15 s deadline: a daemon that accepted the connection and
  stalled held one probe for the general 300 s. Each probe is bounded by the remaining budget
  (unit test against a stalled listener).
- `fs_read_tail` accepted any path and any line count. It reads only the application's own log
  file, and the count is clamped (tested both ways).
- A folder-size job started on one host was polled and stopped on whichever host was current;
  the job now keeps the host that issued it.
- Local path semantics (breadcrumb, listing, mount decisions) came from the machine serving
  the page; they now follow the selected host's OS (`separatorForOs`, `hostSeparator`,
  `isHostWindows`). The home folder of a remote host is still the server's.
- A managed daemon restart stranded the mobile pairing tunnel on the old port and credentials;
  the server now rebuilds it when the daemon comes back on another address (unit test on the
  staleness rule; the rebuild itself needs cloudflared).
- Turning automatic rclone updates off also skipped the update check, so the promised
  "you can update from Settings" notice never came. The check runs on every boot; the setting
  decides between installing and announcing.
- CLI: download errors (request, response, dropped connection, redirect loops) now reject the
  promise and remove the partial file; a launcher that exits with an error is reported instead
  of a successful open (`node --test` in `cli/`).
- Commander: deleting a local file or folder sent rclone a bare `:local:` root with a relative
  path, which rclone resolves against the daemon's working directory. It only worked when that
  happened to be the filesystem root (an app launched from Finder); from a terminal or in browser
  mode the delete failed with "object not found". The shared rename-and-delete hook makes the
  root absolute, as every other local call already did. Covered by the picker test, which checks
  the disk.
- A page's first host-store write could land before its host document had been read: the
  browser shell rendered once the app document was in, while the host document was still
  loading, and the sidebar's "note the remotes I list" effect then patched the store's defaults
  over the document. Visible as `remoteFirstSeen` re-stamped on every page load (the sidebar's
  newest-first order never settled) and, once a job's settings were recorded, as that record
  wiped by the next page. Both shells now wait for the host store before rendering
  (`ensureHostStore`), and the state adapter drops any write to a document it has not read,
  with a console warning. A state-adapter test writes before reading and finds nothing saved.
- A page could undo another writer's state, in two ways with one cause: the adapter worked out
  what a page had changed by comparing the page's state with **the server's document**, so any
  key the page had not caught up on read as a change of its own. (1) A page that hydrated an
  unwritten document, and wrote after another page had created it, found the document in its
  own read instead of in a refused creation and took the ordinary path: the other page's keys
  were `unset`, or reset to this page's defaults. Which path it met was timing, which is why
  the test for it ("two pages creating the same document keep both their keys") failed only in
  full runs; a loop of 150 rounds lost the key in 147. (2) A page whose write was refused (409)
  adopted the newer revision for its next `If-Match` while its store still held the old values,
  and the announcement of that revision was then ignored as "not newer than known": its next
  write put the old values back, for good. `lib/api/state.ts` now keeps the two apart — `known`,
  the server's document as last seen (what a write is conditioned on), and `mine`, the state the
  page's store last read or wrote (what its changes are measured against) — treats a document
  found at write time like a refused creation, and remembers when a store is `behind` a revision
  the adapter adopted, so the next announcement rehydrates it. Covered by the creation race in
  the order that fails, a page writing `y` then `z` while holding a stale `x`, and a real store
  whose socket is held back while another writer renames the host: it leaves the name alone
  through two writes of its own, and shows it once the announcements arrive. The last was
  checked to fail with either half of the fix undone.
- Two Rust tests (the webhook dispatch to a dead endpoint, the run lock's flock probe) used a
  fixed temporary directory, so two test processes running at once swept each other's files and
  failed. Their directories carry the process id now, as the transfers tests' already did.
- The e2e suite made rclone walk the whole home directory under itself. A picker or the
  Commander sizes the folders it lists, each as an `operations/size` job, and a page stops its
  own on `pagehide`; a page Playwright tears down never runs that, so the jobs of a picker
  opened on `~` went on for minutes (2.9 million entries listed 15 s after the page was gone,
  some 640,000 symlink notices a run) under every test that followed. That was the "load" the
  suite's intermittent failures were sensitive to. `stopLeftoverJobs` (`e2e/helpers.ts`) stops
  what is still running on the shared daemon after each test of the specs that drive pages; a
  full run went from about 3.6 to 2.4 minutes. Separately, the Dashboard transfers test left the
  daemon's speed above zero for the next spec's "Idle" check; it resets the stats as the other
  throttled tests do.
- A page's own state writes raced each other: every store update became a `PATCH` carrying the
  last revision the page knew, so two updates in one tick (the Dashboard's onboarding effect
  ticking several steps) had the second answered with 409, recovered by re-reading and retrying
  but logged by the browser as an error. Writes to a document now queue per document in
  `lib/api/state.ts`; the 409 path stays for other writers. Covered by a test that fires two
  writes at once.
- Commander, Windows: a click on a segment of the path bar rebuilt the local path as
  `/C:/Users/…`, which lists nothing. Local paths are now rebuilt with the host's separator and
  the drive in front (`joinLocalSegments` / `localRootOf` in `lib/format.ts`); the Local button
  goes to the drive's root. A path typed with forward slashes (`C:/Users`) is no longer taken
  for a remote named `C`. Covered by a pure test and a Commander test.
- The host-change handler in `src/main.tsx` cleared the query cache on every load (hydration
  moves `currentHostId` from `null` to the saved host), which silently killed fetches already in
  flight and left their observers pending for good; the browser sidebar's status card was the
  first to show it. Hydration now skips the reset, and a real host switch resets and refetches the
  active queries instead of clearing them.
- The Commander read its `?path=` target once on mount, so a second deep link while it was open
  (the browser sidebar's remotes) did nothing; it now moves the right panel.
- Cleared settings were never persisted: the state adapter only sent keys that were present, so
  "Remove password", "Clear" proxy and "Reset to default" toolbar shortcut came back after a
  reload. The page now sends `unset` and the server deletes those keys.
- Copy and Move read `initialDest` while the toolbar passes `initialDestination`, so a
  destination handed over from the toolbar was dropped.
- Dropping a folder in the Commander copied it as a file (the drop payload typed items by a
  trailing slash that folder paths never carry); the drag payload now carries the item types.
- The Commander's "Overwrite existing files" checkbox mapped to `no_update_modtime` instead of
  `ignore_existing`, so unchecking it did not prevent overwrites.
- Editing an encrypted config silently dropped its saved password (the drawer compared
  `passCommand` against `null` when the value is `undefined`).
- The template drawers closed and wiped every field when the name was empty; a command without
  any `--` flag "imported" one bogus flag named after its last character.
- The mount point picker offered remotes because the destination field dropped `allowedKeys`.
- A colon inside a path was treated as the remote separator in both `lib/format.ts` and the
  Rust mirror, so `gdrive:/notes/meeting 10:30.txt` targeted `notes/meeting 10`, and a local path
  containing a colon was treated as a remote.
- Download progress never reached the Binary settings page: Rust emitted `rclone-download-progress`
  while the page listens for `rclone.download-progress` (a test now checks emitted names against
  `lib/api/events.ts`).
- An auto-mount option group emptied to `{}` was never saved, so those options could not be
  cleared.
- Template ids created from an operation window used a per-second timestamp and could collide.
- The folder picker opened on the local disk for a bare remote root such as `gdrive:`.
- The Settings page logged six lines on every render to the host's log file.
- Crash handling in the supervisor: the failure counter reset on every successful start, so a
  daemon that came up and died seconds later restarted every two seconds forever (with a webhook
  each time) and the "keeps crashing" question was unreachable. The counter now resets only after
  30 s of uptime; the desktop gets its Relaunch/Exit dialog after five crashes in a row, the
  standalone server keeps retrying at the longest backoff instead of parking (also after five
  failed starts), and the crash notification fires once per streak plus once at the limit.
- The proxy connectivity probe on daemon start hit four public endpoints with 10 s timeouts
  each (up to 40 s of boot delay); it now uses only `www.cloudflare.com/cdn-cgi/trace` and runs
  once per proxy URL per process.
- The remote form dropped every option whose rclone type was neither `string` nor `bool` (216
  on rclone 1.75: the sftp/ftp/smb port, chunk sizes, encodings, durations, upstream lists, the s3
  Tristate switches). Two of them are required, so `combine` and `hdfs` remotes could not be
  created from the UI at all; `union` only worked because its `upstreams` is declared as a string.
- Closing a file preview inside the file picker by clicking next to it closed the whole picker
  too (two nested drawers both treated the click as "outside"); the full-screen picker is no
  longer dismissable by clicks, so only the preview goes.
- Suggestion lists in the remote form (S3 `provider`, chunker `hash_type`, …) lost typed values
  on Tab: the list opened on focus with its first item highlighted and the Tab key committed that
  item, so typing `6M` and tabbing on stored `16M`, and tabbing through a field that held a custom
  value replaced it with the first suggestion. The list now opens while typing, matches by
  prefix, and Tab keeps the typed text; Enter still picks the highlighted item.
- The Remotes option section appeared for a copy, move, sync or bisync between two local paths,
  and opened on nothing: its tabs are one remote's backend options each, and a local path names
  no remote. The pages counted any non-empty path as a selected remote; they now count only the
  ones that name one (`pathsWithRemote` in `lib/format.ts`, which also excludes `:local:`).

## Simplifications

The review in `__review__/V_SIMPLIFICATIONS.md` proposes twenty-two changes; the ten bounded
ones and the six medium ones with test baselines are done here (the five that need their own
design, scheduler definitions, the daemon's lifetime owner, selection ownership, the directory
lifecycle and the CodeMirror editor, are not). Each entry removes a rule that was written more
than once or a state that was kept in sync by hand; the existing tests are the regression net
and a test was added only where a refactor made a seam worth pinning. Line counts are before
and after this pass.

- The unused binary RPC protocol is gone: `rpcBytes` / `rpcUpload` (`lib/api/rpc.ts`, 129 →
  103), `Reply::Bytes`, the octet-stream branch, the `X-RcloneUI-Args` header and the raw body
  (`src-server/src/rpc.rs`, 113 → 92) and `parse_channel_ref` (`src-shared/src/sink.rs`,
  106 → 94). `/api/rpc` is JSON in and JSON out; `/api/rc`, `/api/dl` and streams are unchanged.
- Server RPC names are declared once: a `server_rpcs!` macro in `src-server/src/server_rpcs.rs`
  expands the grouped handler arms into `SERVER_RPCS`, the team admission check and the
  dispatch match, so a name can no longer be listed without being dispatched or the other way
  round. A table test checks that every listed name dispatches, an unknown one errors and the
  list has no duplicates.
- One atomic file write: `fsutil::write_atomic` (`src-shared/src/fsutil.rs`) replaces the four
  copies of "write `.tmp` next to the target, rename" in the state store, notification targets,
  the team file and the scheduler's job files; each site keeps its lock and its error wording.
  Unit tests cover replacement, parent creation and the temp file after a failed rename.
- Missing and unreadable state are told apart: `StateStore::state_or_error` for the lifecycle's
  host read and the desktop boot (a read error is logged instead of silently emptying the
  document), `state_or_default` for the two display reads that want the default.
- One version comparison: `src-shared/src/version.rs` (`compare`, `newer`) replaces the three
  parsers in the binary resolver, the zookeeper and the server updater, accepting the union of
  their forms (a leading `v`, a `-suffix`, missing components as 0), with tests.
- `flushHostStore` waits for the document's write queue (`whenWritten` in `lib/api/state.ts`)
  instead of sleeping 150 ms; the two-writes test reads the document after the barrier.
- `hydrated(persist)` resolves on zustand's own hydration callback instead of polling every
  50 ms; `waitForHydration` is gone.
- `lib/rclone/client.ts` no longer imports `api.ts` dynamically to reconnect a remote (a cycle):
  it exposes `setReconnectHandler`, which `src/main.tsx` sets at composition.
- The "needs to be reconnected" prompt is offered again when it is needed again. The claim that
  keeps several windows from all asking at once (`claim_reconnect_dialog`) was a set the server
  only ever inserted into, so the prompt appeared **once per remote per process**: dismiss it, or
  reconnect and have the token expire again weeks later, and the remote just kept failing with
  the one thing that would fix it suppressed. The claim is now released when the dialog is done
  with (`release_reconnect_dialog`, from a `finally`), and a claim nobody gave back expires after
  fifteen minutes so a page that was closed mid-dialog does not silence it either. Claims are
  keyed `host:remote` rather than by name alone: two hosts can each have a `drive`, with tokens
  that expire on their own schedules, and the second used to be unable to ask.
- Selecting a remote in the Commander offers to reconnect it every time, not once. This needed no
  new code — releasing the claim is what restored it — but it is now pinned by a test: choose a
  stale remote, dismiss, visit a working one, come back, and the offer returns.
- The Dashboard's Remotes card says how many need reconnecting and opens a drawer listing them,
  each with a Reconnect button running the same sign-in the prompt does
  (`src/components/RemotesReconnectDrawer.tsx`). The count comes from a quiet check as the page
  opens — `operations/fsinfo` per token-holding remote, cached for the day
  (`lib/rclone/reconnect.ts`). Quiet is the point: through the normal client that check would
  throw a reconnect dialog at somebody who only opened the Dashboard, so it goes through
  `rcFetch` and reads the error itself. It also keeps its own query key: `fsinfo`'s is what the
  file panel relies on to fail and offer the prompt, and a check writing its error there would
  leave the panel with a cached failure and nothing to offer. The regex that recognises rclone's
  advice now lives in one place and is shared with `client.ts`.
- Two UI fixes found while building it: the rail buttons in the Commander's Places list had no
  accessible name, so every Google Drive remote was announced as "drive"; and the sign-in dialog
  clipped its last two buttons once it grew to four, which it now has room for and wraps if it
  ever runs out.
- The six request builders in `lib/rclone/requests.ts` (717 → 685) share `operationParams`
  (the group merge, `_config` / `_filter`, the folder-filter assertions), `withRemote` (per-remote
  overrides) and `batchRequest`; each keeps its own shape. `e2e/requests.spec.ts` snapshots one
  request per builder (`e2e/requests.spec.ts-snapshots/`).
- The desktop settings window renders its tabs from the section catalog (`src/pages/Settings/
  index.tsx`, 313 → 159): a `DESKTOP_TABS` order plus the catalog's `localOnly` rule gives the
  tooltip and the disabled state, in place of twelve hand-written tabs.
- The cron day-of-month / day-of-week relationship is decided once: `DayConstraint` in
  `src-shared/src/scheduler/cronconv.rs` (`Any`, `MonthDays`, `Weekdays`, `Either`, `Both`) is
  what `matches`, `next_fires`, `to_launchd` and `to_schtasks` consult, instead of four
  reconstructions of the same tables. An equivalence test runs the old decision logic as the
  oracle over a grid of combinations.
- The scheduler takes one inventory per backend and operation: `SchedulerBackend::inventory`
  (cron: one crontab read; launchd: agents and parked dirs with their loaded state; schtasks: one
  query; ticker: its files) feeds both `scheduler_status`, which looked every task up separately
  (cron reread the whole crontab per task), and the orphan sweep, now one loop in
  `scheduler/mod.rs` over each inventory minus the keep set. A failed inventory marks that
  backend's tasks `installed: false` with a warning naming the failure, and the sweep skips the
  backend: an inspection failure never authorises a deletion. Tests cover owned and foreign
  artifacts, a disabled one, and an inventory failure. A crontab marker line whose entry is
  missing is no longer removed by the sweep on its own (it is inert; uninstalling the task
  removes it).
- The six transfer pages share one submission hook, `useOperationSubmission`
  (`src/components/operation/`, 172 lines): validation, the start mutation with `onStarted`
  and the optional schedule, the dry run, the button text and icon, and the three resets. Copy
  389 → 293, Move 388 → 292, Sync 395 → 303, Bisync 489 → 424, Delete 342 → 243, Purge
  242 → 172. Copy and Move keep their licence gate, Bisync its separate live and scheduled
  argument builders, Delete its success notice. Two visible changes: the schedule-validation
  dialog's wording is now the same on every page, and Bisync's "reset all" clears the cron
  too, as the other pages do.
- The remote drawers share one form model: `useRemoteForm` (`src/components/remote/`, 82
  lines: backend enrichment and ordering, the provider filter, the saved / pending / effective
  values and the own-credentials rule) and `RemoteFields` (70 lines: the normal fields, "More
  Options", the advanced fields). Create 365 → 281, Edit 322 → 230. Edit still writes only
  what changed and keeps `provider` read-only; Create keeps type switching and the OAuth
  cancellation. `RemoteField` still takes the whole config with a setter, because three of its
  sub-fields (the Filen key, the remote path and the path picker) read sibling values.
- The template drawers share one draft: `src/components/template/draft.ts` (121 lines) holds
  the eight option groups, the split (`draftFromOptions`, Serve protocols folded into one) and
  the join (`optionsFromDraft`, the same precedence as before), the Serve tab's flag lists, and
  the command-line import as a pure function (`optionsFromCommand`) applied on the debounced
  input instead of modelled as a query. Add 664 → 539, Edit 506 → 429. `e2e/template.spec.ts`
  pins the import, the round trip and the Serve fold. A command line without `--` imports
  nothing (it used to import its last character as a flag).
- The toolbar generates results from a snapshot: `Toolbar.tsx` builds `ToolbarSnapshot` (host is
  local, mounts, serves, VFSes) from its queries and passes it in the action context, so
  `getResults` reads no query cache and no store; execution handlers keep their side effects.
  The four transfer actions come from one `transferAction` factory (`toolbar/actions.ts`,
  1403 → 1238; `Toolbar.tsx` 573 → 580).
- The supervisor takes the daemon's exit typed. It used to build an `RcloneEvent`, serialise it
  to JSON through the page-facing `Sink`, and parse it straight back to decide restarts and crash
  backoff. `zookeeper::spawn_rclone_with` takes an `OnDaemonClose` callback and holds the spawn;
  `spawn_rclone` stays as the thin wrapper that serialises onto the caller's stream, so the
  command table, the desktop wrapper and the page contract are untouched. Two tests cover the
  typed delivery and the refusal of a second daemon. The daemon's ownership is unchanged: the
  PID, the intentional-stop flag, reaping and restart coalescing all stay where they were.
- The file panel's selection is one ordered map of path to type
  (`src/components/navigator/useFileNavigation.ts`, 949 → 924). It was a set of paths in state
  beside a map of types in a ref, which five operations had to keep in step at eight sites; a
  path could in principle be selected with no type recorded, which is why `getSelection` guessed
  from the entry cache and then from the shape of the path. Both guesses are gone. The panel, the
  Commander and `PathSelector` are untouched: they still read a derived `selectedPaths` set. The
  unused `setSelectedPaths` escape hatch was dropped.
- One directory load, three row shapes. The remote and local branches called the same `listPath`
  with the same options and then repeated the same failure handling, and the rows were committed
  at three separate places. `loadDir` now has one `fail` and one `commit`, with favorites, remote
  and local differing only in how they produce rows. Two deliberate behaviour changes: a failed
  remote listing now drops that folder's cached rows, as a failed local listing already did, so a
  retry cannot flash the old contents; and the listing paints inside a transition, which the
  favorites branch and the cache-hit paint already did. Recursive search keeps its own lifecycle,
  which is sequenced by request numbers rather than the listing's abort controller.

## Tests and CI

- Rust: 144 unit tests across the core and server (state store patching and unsetting; the
  static asset key, which decodes a percent-encoded file name and refuses one that climbs out;
  the
  server log's rollover; the
  storage migration engine's marker, resumption, root fold, store-file conversion, binary
  adoption and the runner's guard; the command table and the server RPC table; atomic writes
  and cross-volume moves; version comparison;
  cron parsing and conversion for all three backends, the day-constraint equivalence and the
  scheduler inventory; crontab, launchd and schtasks rendering; run locks; notification targets and webhook
  dispatch against a local receiver; the SMTP settings' view without the password and an email target mailed through a local SMTP stub (or told why not, when no server is saved), and a duplicate email target refused in its own words on add and on edit; config-sync truth model; startup-mount parameter encoding
  including the Metadata split; download event names; the transfers ledger's fold, compaction and two-writer list; the transfers service's recovery, daemon stop, stop-is-not-failure, status reading, failures gathered across snapshots and the request kept from start to end; a run's transfer paths; the metadata mapper's rules — rename, constant, drop, their
  precedence and a refused argument).
- Playwright end-to-end suite (`npm run test:e2e`, `playwright.config.ts`) against a real
  `rclone-ui-server` and a real `rclone rcd`, on three servers (all with the owner account, one
  external daemon, one password-and-team test bed, one managed daemon): 158 tests covering the shell and dashboard, the tab icon that swaps its fill with the browser's colour scheme, the header's cog, the Commander's shortcuts cog, a favourites row that offers only its star and names its path on hover, the Commander's hover icons fitting the column they left room in, the Serve address field and its `addr` flag being one value, a backend icon whose name needs escaping, and the browser's Rclone screen (three releases, then ten more per Load more, and one proxy group), the SMTP screen keeping its settings and never handing the password back, the Notifications page offering Email where Telegram (botless) was and an email test mailed through a local SMTP receiver (then refused by a dead port, with the card's warning), every operation page's link to its rclone.org command page, the wizard and its hand-off to the Copy and Serve pages (its metadata step waiting for a whole rule, and the Copy page's panel showing it), the Commander path bar opening `remote:folder` as the remote and refusing `-bad:x` and `C:\Users\me` with the reason, a Copy source that cannot be sent said under the field and on the start button, a folder typed without a slash copied as a folder and a file typed with one as a file (against real rclone), a purge of a file refused by name, the picker handing a folder over without a slash, a scheduled task saved with what its sources are and its job file built from that, the create drawer refusing a one-letter name, a finished transfer reopened from the Transfers drawer with its settings and its files read from the record, a transfer listed the moment it starts (refused on an endpoint that does not start one, failed when its launch dies), finished transfers read back after the server process is restarted on the same directory, a running transfer's live speed and its stop recorded as stopped, a launch that dies on an expired sign-in still offering to reconnect (the error comes back from the server now, not through the rclone client that makes the offer), a scheduled run's row opening its schedule in a new tab (or its own drawer once the schedule is gone), a file that failed inside a folder copy (made unreadable, against real rclone) kept with the record and retried as a transfer of its own, the retry drawer listing only what failed and retrying first one file and then the rest, the transfer drawer's sections (only those with something in them, folding and unfolding), its top box holding the one error that is no file's and neither a file's error nor "operations failed", its header tooltip and its own close button, the Dashboard's panel listing a finished transfer after rclone's own memory of it was reset and a running one under "live" with its progress, the Commander's bar showing a dropped file and then asking rclone nothing more once the job has ended, no source file but the live reads naming a job endpoint, a Commander download started from its row's button and saved through the in-page picker being a recorded transfer tagged `commander` (in the Commander's bar, and in Transfers with its badge), an operation page's transfer tagged `operation`, a scheduled run being one by its tag, a config file saved through the daemon leaving the Dashboard's Files figure where it was while a two-file transfer adds two, and not ticking "Move some files" on a server that has never transferred anything, a transfer whose daemon was killed and replaced on the same address (with a finished job under the same id) ending as interrupted and not as that job's outcome, renaming and deleting inside the path picker, a stuck OAuth login stopped by a new one and a cancelled one stopped on the daemon, the Commander's path bar, a `--clear` start, a start on a directory laid out by the old app (migrated once, then read as is), renaming a remote through the daemon's config file (external and managed daemons), routes and capability gating, the
  RPC envelope, state documents with conflicts and cross-window refresh, in-page dialogs,
  streamed listings and the folder picker, the rc proxy with uploads, range requests and signed
  downloads, login, the managed daemon's start and restart, the crash-streak count, the auth
  guard, the wrapper-remote picker, creating `combine`, `chunker` and `local` remotes from typed
  and picked option values, browsing a path option from its current folder, the metadata mapper's panel writing a command
  line into the flag as a rule is completed (and following a hand edit of the JSON back into rules), rclone running the app itself as that mapper, and
  page flows for each bug fixed above; plus node-side specs for path parsing, option types, the metadata mapper codec, the Wizard's model (which operations are asked about metadata, and what the answer amounts to), the path grammar (41 spellings read by the grammar and by the real daemon through `operations/fsinfo`, the slash kept by the local backend and trimmed by memory, both roots climbed without a slash invented), the builders taking rclone's answer over the trailing slash, operation presets,
  the request builders (snapshots), the template draft, the transfers rows (record plus live numbers) and the retry rules, and a layout spec for horizontal overflow
  (`e2e/*.spec.ts`; `format.spec.ts`, `optionTypes.spec.ts`, `pages.spec.ts`, `preset.spec.ts`,
  `requests.spec.ts`, `template.spec.ts`, `transfers.spec.ts`, `transferRetry.spec.ts`, `metadataMapper.spec.ts` and `layout.spec.ts` are
  untracked).
- `.github/workflows/check-server.yml`: a GTK-free container build of the shared and server
  crates with the dependency-tree guard, the `check:no-tauri` script, `cargo test`, and the
  Playwright suite on Ubuntu.
- `.github/workflows/release-server.yml`: release binaries for Linux (x86_64, aarch64), macOS
  (aarch64, x86_64) and Windows, signed with the updater key, `server-latest.json`, and a
  multi-arch Docker image on GHCR.
- The desktop release workflows cache the workspace-level `target/`.

## Build tooling and repository hygiene

- `npm run build` no longer runs `buildExternal.js`; new scripts: `build:server`, `dev:server`
  (server with `--dev-proxy http://localhost:1420`), `docker:build`, `check:no-tauri`, `test:e2e`.
- Vite: the pages are always served through the server's dev proxy; HMR on port 1421; the Rust
  crates and `target/` are ignored by the watcher.
- `.gitignore`: `/target`, `/src-frontend/e2e/.tmp`, `/src-frontend/test-results`,
  `/src-frontend/playwright-report`.
- Remotion video tooling for the docs, now in `src-video/` (see Repository layout below).
- `CLAUDE.md` (project conventions for the new shape), `EXPLANATION.md` and
  `EXPLANATIONS_SHORT.md` (architecture write-ups) are new and untracked.

### Repository layout: `src-frontend/` and `src-video/`

- The frontend was seven directories and eight loose files at the repo root, sitting next to the
  three Rust crate directories. It is now one directory, `src-frontend/`, holding `src/`, `lib/`,
  `store/`, `types/`, `toolbar/`, `public/`, `e2e/`, `scripts/`, `index.html`, `reset.d.ts` and
  its own `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tailwind.config.js`,
  `postcss.config.js` and `playwright.config.ts`. Nothing inside the moved files changed: the
  whole set moved together, so all 402 cross-directory imports still resolve, and none of them
  named a path as a string.
- `src-frontend` is an npm workspace member with its own `package.json`, holding the app's 38
  dependencies and 13 dev dependencies. The root `package.json` is the workspace root and keeps
  only what is not the app's: Biome, the Tauri CLI and the Remotion toolchain. Its `dev`,
  `build`, `preview`, `test:e2e` and `check:no-tauri` scripts delegate with `-w src-frontend`, so
  CI, the `Dockerfile` and `tauri.conf.json`'s before-commands invoke exactly what they invoked
  before. `cli/` is deliberately not a member: it publishes under the same name as the root.
- The bundle is built to `src-frontend/dist/`, and rust-embed follows it
  (`#[folder = "../src-frontend/dist"]`), as do the `Dockerfile`'s two stages, `.dockerignore`
  (whose `node_modules` became `**/node_modules`, since a root-level pattern there does not match
  a nested directory), `.gitignore` and `biome.json`.
- The Remotion video project became the second workspace member, `src-video/`: the
  compositions, the mocks, the DaVinci scripts, `remotion.config.ts` and its own `tsconfig.json`.
  The 20 `video:*` scripts moved with it and are run as `npm run <script> -w src-video`; the root
  no longer mirrors them.
- `out/` moved in too, as `src-video/out/`: 27 GB of renders, narrator rolls, DaVinci exports and
  a Python virtualenv, which had been sitting untracked-but-unignored at the repo root (214 files
  in `git status`) and is now covered by the directory's ignore rule. The scripts that reach into
  it were re-anchored rather than re-prefixed: `REPO`, which pointed at the repo root, became
  `ROOT`, the video project's own root (`ARGS.root` in the Lua jobs), one directory level
  shallower. Every path string they build went back to its original short form — `out/narrator/…`,
  `voiceover/…` — instead of carrying a `src-video/` prefix, and a relative path typed on the
  command line (`--narrator out/narrator/x.mp4`) still means what it did before. In `_lib.lua` the
  parameter is `projectRoot`, because that function already has a `root` (the media pool's).
- `src-video/package.json` declares what the compositions import: the Remotion toolchain,
  `@fontsource-variable/inter`, and the eight packages they share with the app. Those eight carry
  the same ranges as `src-frontend`'s on purpose — npm then hoists a single copy of each, and two
  copies of React (or of anything carrying a context) in one webpack bundle is an
  invalid-hook-call crash.
- The directory is gitignored apart from its `package.json` (`src-video/*` with
  `!src-video/package.json`): it carries 30 MB of media, including a 22 MB capture, but `npm ci`
  needs the manifest to resolve the workspace from a fresh clone.
- 48 imports across 25 files in the video project reached into `lib/`, `src/`, `public/`,
  `store/` and `types/` at the old repo root; they now point into `src-frontend/`. Its
  `tsconfig.json` follows the same way.
- Tailwind's config gained `content: { relative: true }` so its globs resolve against the config
  file rather than the working directory — one config now serves both Vite, which runs in
  `src-frontend`, and Remotion, which runs in `src-video` and is pointed at it through
  `enableTailwind`'s `configLocation`.
- The root `package.json` is now only a workspace root: no `dependencies`, and two
  devDependencies left (Biome, which the repo-wide config covers, and the Tauri CLI). The
  `sources:cargo` script was dropped — it ran `scripts/flatpak-cargo-generator.js`, deleted
  earlier on this branch — along with the `esbuild`, `yaml` and `@iarna/toml` devDependencies,
  which no file in the repo imports.
- Its script list went from 34 to 14: the 20 `video:*` entries now belong to `src-video`,
  `preview` served a bundle that cannot boot without the server's injected payload, and
  `build:windows:arm`, `build:linux:arm` and `build:wasm` went with the `below targets do not
  work` placeholder that labelled them. What is left is what CI, the `Dockerfile` and
  `tauri.conf.json` call by name, plus the Tauri release builds and the server commands.
- CI and the `Dockerfile` install with `npm ci --workspace src-frontend --include-workspace-root`,
  which resolves 698 packages instead of 951: neither renders videos, so the Remotion toolchain
  and its platform binaries are skipped.

#### Video project repairs found while moving it

The project had not built since the server split removed the Tauri packages; the move surfaced
that, and three fixes were needed to get `npm run video` working again.

- `mocks/hosts.ts` imported `platform()` from `@tauri-apps/plugin-os`, which no longer exists. It
  now reads the user agent — a render is headless Chrome on the rendering machine, so it answers
  the same question. `mocks/setup.ts` still mocks Tauri's IPC, so `@tauri-apps/api` is declared in
  `src-video/package.json` and nowhere else; that mock layer is stale and wants rewriting against
  `lib/api`, which is its own piece of work.
- `src-video/tsconfig.json` repeats `"jsx": "react-jsx"` rather than inheriting it. Remotion's
  esbuild loader reads `<remotion root>/tsconfig.json` with `typescript.readConfigFile`, which
  does not follow `extends`. Collecting the frontend had moved the root `tsconfig.json` out from
  under it, so every component was compiling to the classic JSX transform and the render died on
  `React is not defined`.
- Webpack's build cache follows Remotion's root, so it now sits in `src-video/node_modules/.cache`
  rather than the repo's. A stale copy there hid the fix above through several rebuilds.

Verified by listing all 169 compositions and rendering a still (`docs-ui-explainer-sync`, frame
150, half scale), which comes out fully styled. Scenes that read persisted state still log a 404
for `/api/state/app`: the app's state layer wants a server, and the mock layer does not provide
one. That is pre-existing and does not stop a render.
- Two path references outside the frontend followed it: the Rust test that reads
  `lib/api/events.ts` to check the daemon's download events are declared there
  (`src-shared/src/zookeeper.rs`), and the debug server binary, which `playwright.config.ts` and
  two specs in `server.spec.ts` each spelled out separately. That is now a single `SERVER_BIN` in
  `e2e/helpers.ts`, anchored to that file rather than to the working directory.

## Compatibility notes

- The mobile app must send the daemon credentials from the pairing QR code as Basic auth; this
  ships together with a mobile app update.
- Prompts, confirmations and file pickers are drawn inside the page instead of as OS dialogs.
- Transfers started before this version are not in the record: the Transfers list starts empty
  after the update. Webhook event ids (`job.started`, `job.completed`, `job.failed`) and their
  payloads are unchanged.
- Stopping a stuck OAuth login needs rclone 1.75 (`config/oauthstatus`, `config/oauthstop`);
  an older daemon answers the status call with an error and the login runs as before.
- The binary RPC helpers `rpcBytes` and `rpcUpload` and the server's octet-stream RPC replies
  are removed; nothing shipped used them. `/api/rpc/{name}` takes a JSON body or none.
- `rclone-ui-server` no longer starts without `--password` / `RCLONE_UI_PASSWORD`, loopback
  included, and `POST /api/login` takes `{email, password}`: sign in as `admin@localhost` (or
  `RCLONE_UI_EMAIL`) with the password you already set. `npm run dev:server` uses `rclone`.
- The data directory is migrated on the first launch of this version (the old store files are
  converted and removed, the single-slot rclone binary joins the versioned library). On Windows
  everything moves from `%APPDATA%\com.rclone.ui` to `%LOCALAPPDATA%\com.rclone.ui` on that
  launch; because the embedded server's port is derived from the directory, the web storage
  (query cache, sidebar state) starts cold once there. Nothing changes on macOS or Linux, where
  both directories were already the same.
- `--local-data-dir` and `RCLONE_UI_LOCAL_DATA_DIR` are removed (the server has not been
  released, so no deployment carries them); Docker sets `RCLONE_UI_DATA_DIR` alone.
  `paths.appLocalData` is gone from the boot payload and `app_info` returns `dirs.data` only.
- A scheduled task that fires between an update and the app's first launch is skipped once: the
  runner refuses a directory whose layout is not the one it reads. On macOS the updater relaunches
  at once; a Linux package update without a relaunch pauses schedules until the app is opened.
  On Windows a task registered before the move names the old directory and is skipped until the
  startup reconcile rewrites it, which already re-registers every task from its job file.
- Windows and Linux desktop builds compile but have not had a manual pass on the tray, deep
  links, updater dialogs and quit-with-transfers.
