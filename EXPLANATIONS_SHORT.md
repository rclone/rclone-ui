# Rclone UI architecture, the short version

## What we had

Two products that shared code badly.

- The desktop app ran its startup logic (find rclone, pick a config, start the daemon, watch
  jobs, mount on start, check the license, reconcile schedules) as TypeScript in a hidden 1×1
  window (`main.ts`, 925 lines).
- The browser server ran the same logic in Rust (`src-shared/src/lifecycle/`), because a server
  has no window to run TypeScript in.
- The frontend imported Tauri packages in 81 files. To make it run in a browser, the server
  pretended to be Tauri: it answered 66 Tauri plugin commands, and a page-side shim faked the
  `window.__TAURI_INTERNALS__` object.
- Settings were stored in tauri-plugin-store files that every window wrote to independently.
  Two windows writing at the same time could lose one of the writes.

Every startup change had to be made twice, and the fake-Tauri layer depended on undocumented
plugin wire formats.

## What we have now

One server, one API, one orchestrator.

- `rclone-ui-server` (Rust, `src-server/`) serves the frontend and answers its API. It contains
  the core (`src-shared/`) that runs rclone. It is the same binary for a browser deployment.
- The desktop app (`src-tauri/`) starts that server on `127.0.0.1` and opens native windows at
  its URLs. The pages inside those windows talk plain HTTP and WebSocket, exactly like a browser
  tab. Tauri is only used for what needs a native app: windows, tray, global shortcut, deep
  links, self-update, and the few dialogs shown before any window exists.
- The frontend has a single platform layer, `lib/api/`. No page imports Tauri anymore. A build
  check (`npm run check:no-tauri`) fails if one does.
- Settings are stored by the server as JSON documents with a revision number. Pages write only
  the keys they changed and send the revision they read; the server rejects the write if
  someone else wrote in between, and the page retries. Every write is broadcast so open windows
  refresh.
- `main.ts` is deleted. The Rust orchestrator runs for both products. Where it used to show a
  native dialog at boot (system rclone found, config password, proxy down, remote host
  unreachable, rclone keeps crashing), it now asks the host through one Rust trait: the desktop
  answers with a native dialog, the server answers with a fixed policy.

## What the user sees

Nothing changes for desktop users: the same windows, toolbar, tray, shortcut, startup splash,
same behaviour on quit. Their settings are migrated on first launch without touching the old
files.

Two visible differences:

- The local rclone daemon now runs with a random port and a password instead of the fixed
  `localhost:5572` without auth. Pages reach it through the server. The mobile pairing QR code
  therefore includes the daemon's credentials, and the mobile app has to send them as Basic
  auth. This has to ship together with a mobile app update.
- File pickers and prompts are drawn inside the page instead of as OS dialogs.

## How the pieces talk

```
POST /api/rpc/<name>        run a command (the 44 shared ones + about 40 server ones)
POST /api/native/<name>     desktop only: open/focus/hide a window, toolbar, theme
GET/PATCH /api/state/<doc>  settings documents with If-Match revisions
ANY /api/rc/<host>/...      proxy to an rclone daemon, credentials added by the server
GET /api/ws                 events (lifecycle phase, settings changed, window focus...)
                            and the output of streaming commands
GET /__boot?t=<token>       desktop only: turns the per-launch token into a session cookie
```

The desktop server is loopback only and requires the launch token; a random browser tab
opened at that port gets a 401. The standalone server needs a password to listen on anything
but loopback.

## Repository map

```
src-shared/   the core: commands, rclone lifecycle, scheduler, notifications, state store
src-server/   the HTTP server (library + binary)
src-tauri/    the desktop shell (~1.5k lines of Rust, no Tauri commands, no capabilities)
lib/api/      the frontend's platform layer
src/, store/  the pages, unchanged except for imports
```

## State of testing

- `cargo test`: 77 tests in the core, 1 in the server.
- `npm run test:e2e`: 10 Playwright tests against a real server and a real rclone: pages,
  login, the RPC envelope, settings writes and conflicts, cross-window refresh, in-page dialogs,
  a streamed directory listing, the rclone proxy with uploads and range requests, signed
  downloads, and a managed daemon starting and restarting.
- Desktop: booted on macOS in dev mode with an isolated data dir. Server, auth, daemon,
  toolbar, startup and an operation window all worked. Windows and Linux compile but have not
  been run. Tray clicks, deep links, the updater dialogs and quit-with-transfers still need a
  manual pass on each OS.

## Open items

- Mobile app update for the authenticated daemon (see above).
- Manual desktop checklist on Windows and Linux.
- The RPC argument types in TypeScript are written by hand; generating them from the Rust
  structs would catch drift. Not done.
- The boot-time questions are still native dialogs on the desktop. Moving them into a page is
  possible later; it was out of scope.
