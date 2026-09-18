# Rclone UI: one server, one API, one orchestrator

This document describes the architecture after the rewrite that removed the desktop's
TypeScript orchestrator and the Tauri plugin layer from the pages. The same frontend, the same
Rust core and the same HTTP/WebSocket API now serve two products: the desktop app, whose native
windows load the UI from an embedded server, and a standalone server for browsers, containers
and headless boxes. The last section lists the decisions that still deserve a second look.

## 1. The shape

```
 Browser tab ──────────────────┐
 Tauri window (External URL) ──┤  HTTP + WS  ┌──────────────────────────────────────────────┐
                               └────────────▶│ rclone-ui-server (lib)                        │
                                             │  /api/rpc/*     shared command table +        │
                                             │                 server RPCs (app, fs, hosts…) │
                                             │  /api/native/*  the host's NativeBridge       │
                                             │  /api/state/*   revisioned JSON state docs    │
                                             │  /api/rc/<host>/* streaming reverse proxy     │
                                             │  /api/ws        streams + bus events          │
                                             │  static dist/ + boot script (__RCLONE_UI__)   │
                                             │  lifecycle (rclone daemon, watcher, mounts,   │
                                             │  license, scheduler reconcile), bus, state    │
                                             └──────────────────────────────────────────────┘
   standalone: src-server bin (Ticker scheduler, SIGTERM, env_logger, password auth)
   desktop:    src-tauri embeds serve(); NativeBridge = windows/toolbar/theme; tray, deep links,
               updater policy, boot questions as native dialogs; Native scheduler mode
```

Three rules hold the shape together:

1. **Pages never talk to Tauri.** Every platform call goes through `lib/api/`, which speaks
   HTTP and WebSocket to whichever server served the page. `npm run check:no-tauri` fails the
   build if a page imports `@tauri-apps/*` or reads a `__TAURI` global.
2. **One orchestrator.** `src-shared/src/lifecycle/` runs rclone for both products. The
   desktop's hidden window and its 925-line `main.ts` are gone.
3. **The desktop is a shell.** `src-tauri` starts the server on loopback with a per-launch token,
   opens native windows at its URLs, and exposes what only a native app can do (windows, tray,
   shortcut, deep links, updater, boot dialogs) through the server's `Hooks`.

## 2. Repository layout

```
Cargo.toml                 workspace: src-shared, src-server, src-tauri (lockfile + target/ at the root)

src-shared/                lib crate `rclone_ui_shared` — the core. Never depends on tauri.
  src/commands/mod.rs      the command table (for_each_command!) → dispatch(), COMMAND_NAMES
  src/bus.rs, ctx.rs       the broadcast bus; Ctx { dirs, events, daemon, local_fs }
  src/state_files.rs       StateStore: the persisted state documents (see §5)
  src/sink.rs, rt.rs       Sink<T> for streaming results; block_on / spawn_blocking
  src/rc.rs                rclone RC client, ephemeral port + token helpers
  src/zookeeper.rs         rclone binary management
  src/local_fs.rs          streaming local directory listings
  src/scheduler/           cron, job files, history, OS backends, headless runner, ticker
  src/notifications/       webhook targets, dispatch, catalog, OS toast (notify-rust)
  src/lifecycle/           the orchestrator (see §6): mod.rs (Supervisor), resolve, config,
                           hosts, interaction, license, mounts, scheduler_reconcile, watcher

src-server/                lib `rclone_ui_server` + bin `rclone-ui-server`
  src/lib.rs               serve(listener, ServeOpts, Hooks) -> Handle; AppState; capabilities
  src/main.rs              CLI (serve | run-task | list-commands), tokio runtime, SIGTERM
  src/auth.rs              open / password / token modes, /__boot, the request guard
  src/port.rs              deterministic loopback port per data dir
  src/static_files.rs      embedded dist/, the boot script, SPA fallback, --dev-proxy
  src/rpc.rs               POST /api/rpc/{name}: server RPCs, then the shared table
  src/server_rpcs.rs       app/lifecycle/hosts/tunnel/fs/third-party RPCs, /api/status
  src/native.rs            POST /api/native/{name} → the host's NativeBridge
  src/state_api.rs         GET/PATCH/PUT /api/state/{doc}
  src/rc_proxy.rs          ANY /api/rc/{host}/{*path}: streaming reverse proxy
  src/download.rs          GET /api/dl/{token}: signed download links
  src/proxy.rs             POST /api/proxy: allow-listed third-party fetch
  src/ws.rs                one WebSocket per page: stream frames, bus events, reconnect buffer
  src/fs.rs                the fs_* RPCs
  src/updater.rs, autostart.rs, tunnel.rs   the standalone host's Hooks + the cloudflared tunnel

src-tauri/                 the desktop shell
  src/lib.rs               plugins, Builder, setup → shell::boot
  src/shell/boot.rs        the boot chain; Hooks for the embedded server; exit handling
  src/shell/native_bridge.rs, interaction.rs, tray.rs, updater.rs, startup.rs, deeplink.rs
  common/window.rs, common/shortcut.rs, src/jenky.rs   native windows, toolbar, GTK quirk
  empty-dist/              a stub for the bundler; windows load from the embedded server

lib/api/                   the platform layer (see §4)
src/, store/, toolbar/     pages, zustand stores, the toolbar engine — all Tauri-free
src/layouts/Shell.tsx      the browser's single window; src/pages/Dashboard.tsx, Login.tsx
src/components/DialogHost.tsx   renders the in-page dialog queue on both products

e2e/, playwright.config.ts Playwright suite against real servers and a real rclone
scripts/checkNoTauri.mjs   no @tauri-apps / __TAURI in page code
Dockerfile, .github/workflows/check-server.yml, release-server.yml
```

Dependencies point one way: `src-tauri → src-server → src-shared`. CI builds `src-server` in
a plain `rust:bookworm` container and greps both dependency trees for GUI crates.

## 3. The API

### Boot script

The server injects `window.__RCLONE_UI__` into `index.html` before the module script:
`{version, mode, capabilities, os: {platform, family, arch, version, eol}, paths: {sep,
delimiter, home, appData, appLocalData, appLog, temp, download, desktop}, theme, authRequired}`.
`lib/api/os.ts` and `paths.ts` read it synchronously at import, which is what the pages that
used `platform()` / `sep()` at module scope needed. The persisted theme rides along so the
first paint is right without localStorage. The desktop adds `window.__RCLONE_UI_WINDOW__ =
{label}` per window through an initialization script.

### HTTP

| Route | What |
|---|---|
| `GET /__boot?t=&next=` | token mode: sets the session cookie from the launch token, redirects to `next` |
| `POST /api/login`, `/api/logout`, `GET /api/session` | password mode |
| `GET /api/status` | mode, version, uptime, dirs, lifecycle phase, startup status, daemon, tunnel, current host |
| `POST /api/rpc/{name}` | JSON args → `{ok, value}` / `{ok, error}`; raw bytes with `X-RcloneUI-Ok: 1` for byte results; an octet-stream body plus `X-RcloneUI-Args` for uploads; a `stream` id in the args for streaming commands |
| `POST /api/native/{name}` | same envelope; 404 unless the host installed a `NativeBridge` |
| `GET/PATCH/PUT /api/state/{doc}` | `{version, revision, state}`; `PATCH {set}` + `If-Match: <revision>` → 409 with the current document on a stale revision; an unwritten document reads as revision 0 |
| `ANY /api/rc/{host}/{*path}` | streaming reverse proxy: `local` → the managed daemon with its credentials, else a configured host with its Basic auth; bodies stream both ways, `Range` and friends pass through, no body limit, no total timeout |
| `GET /api/dl/{token}` | a 10-minute download link (`Content-Disposition: attachment`); public, because a desktop window's `open` lands in the system browser with no cookie |
| `POST /api/proxy` | a server-side fetch for `gateway.filen.io` only |
| `GET /api/ws` | below |

### WebSocket

The page says `{type:'hello', session}` (its per-page UUID, also sent as `X-RcloneUI-Session`
on every RPC) and pings. The server sends `{type:'ready'}`, `{type:'pong'}`, `{type:'stream',
id, event}`, `{type:'stream_end', id}` and `{type:'event', name, payload}` for every bus event.
Stream ids are generated by the page and passed as `stream` in the RPC's arguments; the
server's `Sink` for that id frames each message and sends `stream_end` when the producer drops
it. Stream frames sent while a socket is reconnecting are buffered briefly; bus events are not
(pages refetch on reconnect).

### Bus events

`lifecycle.phase`, `state.changed {doc, revision, keys}`, `rclone.download-progress`,
`tunnel.changed`, `deep-link.add-template`, `window.focus/blur/moved {label, …}`,
`theme.changed`, `os.toast` (Rust asking the host for an OS notification). The bus is a
`tokio::sync::broadcast` channel in `src-shared/src/bus.rs`; WebSocket sessions, the tray's
icon refresh, the Sentry capture and the toast bridge are all plain subscribers.

### RPCs

The 44 shared table commands keep their names and argument keys. The server adds: `app_info`,
`log`, `app_quit`, `app_relaunch`, `app_update_check`, `app_update_install` (streams progress),
`autostart_get/set`, `os_notify`, `open_url`, `open_path`, `reveal_item`,
`claim_reconnect_dialog`; `rclone_restart` (coalesced, with the initiating page's overrides),
`rclone_stop`, `rclone_password`, `watch_jobs`; `host_probe`, `download_link`; `tunnel_start/
stop/status`, `cloudflared_installed/provision`; `fs_exists/read_text/read_bytes/read_tail/
write_text/write_bytes/mkdir/remove/copy/read_dir/stat`; `license_validate/revoke`,
`rclone_latest_version`, `rclone_releases`, `winfsp_download`. The desktop's native bridge
answers `window_open/exists/focus/hide/close/is_focused/outer_position/
set_ignore_cursor_events/start_dragging/toggle_maximize/set_theme/lock/unlock`,
`toolbar_show`, `toolbar_set_shortcut`.

### Auth

- **Open**: the standalone default without a password; loopback only, every request trusted.
- **Password**: `POST /api/login` → HttpOnly, SameSite=Strict cookie; the server refuses to
  bind anything but loopback without one.
- **Token**: the embedded server mints a per-launch secret; each window is opened at
  `/__boot?t=<token>&next=<route>`, which turns it into the same cookie and redirects. Nothing
  outside the shell process ever sees the token; a stray browser tab at the port gets 401.

CSRF: `/api/rpc` and `/api/native` require the custom session header (no CORS preflight is
ever answered), the WebSocket upgrade checks `Origin`, hashed assets and signed links are the
only public paths in token mode.

### Capabilities

The boot payload's `capabilities` is what the pages gate on. `window` and `deepLink` are
desktop-only. `updater`, `autostart`, `processExit` and `osNotifications` are off inside a
container. `mount` is off only on Windows without WinFsp (macOS mounts over NFS, Linux through
the distribution's FUSE); a failed mount on Windows then offers the WinFsp download.
PATH integration, config sync and the mobile tunnel are OS-level and available on both products.

## 4. The platform layer (`lib/api/`)

| Module | What |
|---|---|
| `rpc.ts` | `rpc(name, args)`, `rpcBytes`, `rpcUpload`, `stream(name, args, onEvent)`; 401 → `/login` |
| `ws.ts`, `events.ts` | the socket, `events.on(name, handler)` with typed payloads |
| `state.ts` | the zustand `persist` storage over `/api/state`: reads whole documents, writes only the top-level keys that changed with `If-Match`, retries once after a 409, `watchDoc` rehydrates on `state.changed` |
| `rc.ts` | `rcClient(hostId)` (`rclone-sdk` over `/api/rc/<host>`), `rcUrl`, `rcFetch` |
| `os.ts`, `paths.ts` | synchronous facts from the boot script; lexical `join/dirname/basename` |
| `dialog.ts`, `dialogs.ts` | `message/ask/prompt/pickPath/saveAs`, rendered in the page by `DialogHost` on both products |
| `windows.ts`, `native.ts` | `openWindow/openFullWindow/openSmallWindow/lockWindows/closeSelf`: native windows on the desktop, routes and a busy overlay in a browser tab |
| `shell.ts`, `clipboard.ts`, `fs.ts`, `app.ts`, `lifecycle.tsx`, `host.tsx`, `log.ts` | open URLs/paths, clipboard, the host's filesystem, process/updates/autostart/tunnel/hosts, the live lifecycle phase, `useCapabilities()`, console forwarding |

The pages changed only at their imports and a handful of call sites (`platform()` → the
`platform` constant, `open({directory})` → `pickPath`, `invoke('prompt')` → `dialog.prompt`,
the Toolbar and Startup windows listening to `window.*` bus events instead of Tauri window
events). Every dialog is in-page; the only native message boxes left are the orchestrator's
boot-time questions on the desktop, where no page exists yet.

## 5. State

Persisted state moved from tauri-plugin-store files (a JSON string inside a JSON file, written
by every window) to server-owned documents: `<app_data>/state/app.json` and
`state/hosts/<id>.json`, each `{version, revision, state}`. `version` is zustand-persist's schema
version and only pages change it (their migrations still run, because `version` survives);
`revision` is the server's and is what `PATCH … If-Match` compares. Rust writers (the lifecycle
persisting the adopted binary, config choices, the local host's version, the license flag) use
`StateStore::update` under the same per-document lock. Every write publishes `state.changed`,
which open pages turn into a rehydrate — the same behaviour the store plugin's `onKeyChange`
gave the desktop's windows, now identical for browser tabs.

The first read of a document migrates the old file non-destructively (the original is kept);
`scheduler/storeread.rs`, which the headless `run-task` child uses, reads the new format first
and falls back to the old one, so a scheduled run between an app update and its first boot
still works.

## 6. The orchestrator (`src-shared/src/lifecycle/`)

`Supervisor::spawn(ctx, store, Options)` runs one state machine for both products, published as
`Phase`:

```
Stopped → Resolving → [Downloading | Updating] → Starting → Ready { updated }
                                                 ↘ NeedsPassword (encrypted config, no password)
                                                 ↘ Failed { error, attempts, fatal }
```

- `hosts.rs` settles the current host once per process: a remote host that can't be reached is
  retried or replaced by the local one (`HostUnreachable`), a reachable one gets its
  `os`/`cliVersion` refreshed.
- `resolve.rs` picks the binary with the desktop's ladder (override → stored path, self-healing
  a moved managed version → a legacy single-slot binary → a system rclone, if the host says yes
  (`AdoptSystemRclone`) → the newest downloaded → download the latest stable), then
  `maybe_auto_update` when enabled and the PATH pointer when integration is on.
- `config.rs` resolves the default config location once, materializes it, normalizes the config
  list, picks the active config (asking `SyncedConfigMissing` when an external folder is gone),
  sniffs encryption, and builds the env. An encrypted config without a stored password asks
  `ConfigPassword` (verified with `rclone config dump`, up to three attempts, persisted on
  success); when the host declines, the phase is `NeedsPassword` and the page can answer with
  `rclone_password`.
- The daemon is `rclone rcd --rc-addr 127.0.0.1:<ephemeral> --rc-user … --rc-pass … --rc-serve
  …`, never `--rc-no-auth`. The page reaches it only through `/api/rc/local`, and the mobile
  pairing QR carries the credentials the mobile app must send as Basic auth.
- After `Ready`: config-sync reconcile, license validation with the machine id, the scheduler
  reconcile (`scheduler_reconcile.rs`: re-register every task from its job file, unregister
  strays, sweep orphans), startup mounts (`mounts.rs`, with OS toasts through `os.toast`).
- Restarts are coalesced; a crash restarts with backoff up to five attempts, then asks
  `RcloneCrashed` (Relaunch / Exit on the desktop, park on the server).
- `watcher.rs` polls `/job/status` for the jobs pages register (`watch_jobs`, per page and per
  host) and emits the job webhooks.

`Interaction` is the seam between the shared orchestrator and the host: `ServerPolicy` answers
every question with the standalone default (adopt, use local, continue, park), the desktop's
`DesktopInteraction` shows native dialogs (`shell/interaction.rs`).

## 7. The desktop shell

`shell/boot.rs` replays the old boot chain: the Flatpak permission gate → bind the deterministic
loopback port (`20000 + hash(app_data) % 20000`, so web storage survives relaunches) → `serve`
with `Hooks { Desktop, DesktopInteraction, TauriBridge, TauriUpdater, autostart plugin,
notification plugin, app.exit/restart }` → toolbar window and global shortcut → tray → deep-link
listener → in the background: the update policy from `rcloneui.com/latest` (required or
optional update through the updater plugin), `start_lifecycle`, the queued deep links, the
startup-window driver (opened on `Downloading`/`Updating`, or on `Ready` unless hidden).

Windows are created exactly as before (sizes, cascade, the Linux focus hacks) but load
`http://127.0.0.1:<port>/__boot?t=…&next=/copy` with an initialization script carrying their
label, and forward their focus/blur/move/theme events to the bus. `tauri.conf.json` declares no
windows and no global Tauri object; there are no `#[tauri::command]`s and no capabilities.
Quit and relaunch, from a page or the tray, run the same server flow (transfers check → tunnel
→ daemon → `on_quit`), and `RunEvent::ExitRequested` is refused unless that flow set the flag.

## 8. Scheduling, packaging, security, testing

- Scheduling is unchanged: OS backends on the desktop, the in-process ticker on the server,
  both spawning the same `run-task` child.
- Logging keeps one contract with two writers: the desktop's log plugin writes
  `<app log dir>/Rclone UI.log`, the standalone server writes `<log dir>/rclone-ui-server.log`
  (stderr plus a file rotated at 5 MB, kept next to an overridden data dir). The boot payload
  carries `paths.logFile`, so About's "last lines" and bug reports read the right file on both;
  every page forwards its whole console to it, on both products.
- The server updates itself from `server-latest.json`, which `release-server.yml` builds from the
  signed binaries (`server-<os>-<arch>` keys, same minisign key as the desktop). Under systemd or
  launchd a relaunch exits with code 3 and the supervisor restarts it.
- Browser-tab differences live in `lib/api`: in-page toasts instead of OS notifications, "reveal"
  and "open path" show the location on the server, windows become routes. Native macOS title-bar
  paddings key off `isNativeMac`, never the server's OS.
- `npm run build` → `dist/`, embedded into the server by rust-embed (debug builds read it from
  disk); the desktop's `beforeBuildCommand` does the same. `Dockerfile`, `check-server.yml` and
  `release-server.yml` are as before; `check-server.yml` now also runs `check:no-tauri` and the
  GUI-crate guard for both crates.
- `cargo test -p rclone-ui-shared` (77 tests) and `-p rclone-ui-server` (the port); `npm run
  test:e2e` (10 Playwright tests): the shell and dashboard, route navigation and capability
  gating, the RPC envelope, state PUT/PATCH/409, cross-writer rehydrate, in-page dialogs, a
  streamed listing over the WebSocket, the rc proxy (version, multipart upload, `Range`, signed
  download), login, and a managed daemon reaching `ready` and restarting.

## 9. What still deserves a second look

- **Native dialogs remain for boot questions.** They only appear before any page exists, which
  is the agreed exception; a "first window" that renders those questions in-page would remove
  the last message boxes and the platform-specific text prompt.
- **The Toolbar's cursor hitbox** crosses the bridge on every pointer move that changes state.
  It is one small POST on loopback, but a WebSocket message would be cheaper if it ever shows.
- **`configFiles[]` is written by both the page (`pass`) and the lifecycle (`isEncrypted`).**
  Both patch the whole key; a page saving a password while the lifecycle flips the flag at boot
  can still lose one of the two. Splitting the encrypted flag into its own key would close it.
- **Type generation.** The RPC argument and result types in `lib/api/app.ts` are hand-written;
  a ts-rs snapshot of the Rust wire structs, diffed in CI, would catch drift.
- **The desktop's `frontendDist` stub and Vite's fixed ports** are conventions the shell relies
  on (`1420` for the dev proxy, `1421` for HMR); they are documented in `CLAUDE.md`.
