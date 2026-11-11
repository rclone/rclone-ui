/**
 * lib/shell is the only way that pages reach the app's Go side (through Wails). Pages use this
 * module, and never use `@wailsio/runtime` or the generated app bindings directly. The core's APIs
 * are in lib/core/api.ts.
 */
import { t } from '@lingui/core/macro'
import { Clipboard, Dialogs, Events, Flags, System, Window } from '@wailsio/runtime'
import {
    AgentsService,
    CoreService,
    DevService,
    DialogService,
    LauncherService,
    PathService,
    SystemService,
    UpdateService,
    WindowService,
} from './bindings/github.com/rclone/rclone-ui/app'
import { PageService as LauncherPageService } from './bindings/github.com/rclone/rclone-ui/app/launcher/view/linux'
import type {
    Frame as LauncherFrame,
    Init as LauncherInit,
    Query as LauncherQuery,
} from './bindings/github.com/rclone/rclone-ui/app/launcher/view/linux/models'
import { StatusKind } from './bindings/github.com/rclone/rclone-ui/app/launcher/view/models'
import {
    type AgentsInfo,
    CoreState,
    type CoreStatus,
    type UpdateAvailability,
    type UpdateRelease,
    type UpdateState,
} from './bindings/github.com/rclone/rclone-ui/app/models'
import type { State as PathLinkState } from './bindings/github.com/rclone/rclone-ui/app/pathlink/models'
import type { Status as AgentsStatus } from './bindings/github.com/rclone/rclone-ui/core/agents/models'
import type { Option } from './bindings/github.com/rclone/rclone-ui/core/catalog/models'
import { type DialogKind, request } from './dialog'

export type {
    AgentsInfo,
    AgentsStatus,
    CoreStatus,
    LauncherFrame,
    LauncherInit,
    LauncherQuery,
    PathLinkState,
}

/** The core's states (CoreState in app/core.go). */
export { CoreState }

/** The kinds of the launcher's footer status (view.StatusKind). */
export const LauncherStatus = StatusKind

type Unlisten = () => void

// ---------------------------------------------------------------------------------------------
// Platform. These calls are synchronous, and read the flags that the app puts in every window.
// Paths are built for the machine that the core runs on, which is this one, so lib/paths reads
// the machine here without asking the core. Outside a window (in the tests) there is no shell to
// ask, so the machine reads as Linux with no home folder.

export type Platform = 'macos' | 'windows' | 'linux'

const inWindow = () => typeof window !== 'undefined'

export function isWindows(): boolean {
    return inWindow() && System.IsWindows()
}

export function platform(): Platform {
    if (!inWindow()) return 'linux'
    if (System.IsMac()) return 'macos'
    if (System.IsWindows()) return 'windows'
    return 'linux'
}

function flag<T>(key: string, fallback: T): T {
    try {
        const value = Flags.GetFlag(key) as T | undefined
        return value ?? fallback
    } catch {
        return fallback
    }
}

/** Rclone UI's version. */
export function version(): string {
    return flag('version', 'dev')
}

/** The OS's family and version, for bug reports. */
export async function osDetails(): Promise<{ family: string; version: string }> {
    const info = await SystemService.Info()
    return { family: info.osName || info.os, version: info.osVersion }
}

/** The desktop shell and its version ("Wails v3.1.0"), for bug reports. */
export async function shellDetails(): Promise<string> {
    return (await SystemService.Info()).shell
}

/** Whether this is a release build. A dev build has the test pages and the test language. */
export function isProduction(): boolean {
    return flag('production', false)
}

/**
 * The app's language for this system: the first of the user's languages that the app has, or
 * English (core/i18n's System). It applies while the language setting is empty.
 */
export function systemLanguage(): string {
    return flag('systemLanguage', 'en')
}

/** The user's home folder, where local pickers start. */
export function homeDir(): string {
    return inWindow() ? flag('homeDir', '') : ''
}

/** The app's data folder, which `--data-dir` can change. Pages keep state per data folder. */
export function dataDir(): string {
    return flag('dataDir', '')
}

// ---------------------------------------------------------------------------------------------
// Windows

/**
 * Opens the window for a route ("/remotes?action=create"). The route sets the window's name
 * (windowName) and its size: the Commander fills the screen, the startup screen is small, and the
 * others are standard. If a window with that name is already open, it is focused and navigates to
 * the route.
 */
export async function openWindow(url: string): Promise<void> {
    await WindowService.Open(url)
}

/**
 * This window's name, read from its route. A window opened at /settings is "Settings". The app
 * names windows after the first segment of their route, and uses "Main" for "/" (ForRoute in
 * app/windows).
 */
export function windowName(): string {
    const segment = window.location.pathname.split('/').find(Boolean) ?? ''
    if (!segment) return 'Main'
    return segment.charAt(0).toUpperCase() + segment.slice(1)
}

export const currentWindow = {
    name: windowName,
    close: (): Promise<void> => Window.Close(),
    hide: (): Promise<void> => Window.Hide(),
    focus: (): Promise<void> => Window.Focus(),
    isFocused: (): Promise<boolean> => Window.IsFocused(),
    setTitle: (title: string): Promise<void> => Window.SetTitle(title),
    /** null follows the system. */
    setTheme: (theme: 'dark' | 'light' | null): Promise<void> =>
        WindowService.SetTheme(theme ?? ''),
    onBlur(callback: () => void): Unlisten {
        return Events.On(Events.Types.Common.WindowLostFocus, () => callback())
    },
    /**
     * Calls back when the app asks this window to navigate to a route. This happens when the
     * window is opened again while it is already open, with its own route (from a deep link, a
     * tray entry, or a page's openWindow). The app sends the route to this window alone.
     */
    onRoute(callback: (url: string) => void): Unlisten {
        return Events.On('window:route', (event) => callback(event.data))
    },
    /**
     * Sets whether closing this window asks the page first. While it is on, the close button and
     * close() leave the window open and call the onCloseAsked callbacks instead. A quit closes the
     * window anyway. src/components/unsaved.ts uses it for unsaved changes.
     */
    guardClose: (on: boolean): Promise<void> => WindowService.GuardClose(on),
    /** Calls back when the user tries to close this window while guardClose is on. */
    onCloseAsked(callback: () => void): Unlisten {
        return Events.On('window:close', () => callback())
    },
}

// ---------------------------------------------------------------------------------------------
// Dialogs. Messages, questions, prompts and rclone's config questions are shown inside the page,
// by DialogHost (src/components/DialogHost.tsx), one at a time and in order. The Open and Save
// panels are the OS's own. The caller passes translated text. The default labels are translated
// when a dialog is asked, because this module loads before the language (src/boot.ts).

export type { DialogKind }

export interface MessageOptions {
    title?: string
    /** The colour of the OK button: primary for info, amber for warning, red for error. */
    kind?: DialogKind
    /** The buttons' labels. OK is "OK" unless named, and the others show only when named. */
    buttons?: { ok?: string; cancel?: string; extra?: string }
    /** Draws a warning in red, for a question whose OK deletes or discards something. */
    destructive?: boolean
    /** Closes the dialog when it aborts. The promise then resolves with the Cancel label, or "". */
    signal?: AbortSignal
}

export interface AskOptions {
    title?: string
    kind?: DialogKind
    okLabel?: string
    cancelLabel?: string
    /** As in MessageOptions. */
    destructive?: boolean
    /** Closes the dialog when it aborts. The promise then resolves false. */
    signal?: AbortSignal
}

/**
 * Shows a message and resolves with the label of the chosen button ("OK" when the buttons
 * aren't named). Escape and closing choose the Cancel button, or OK when there is none.
 */
export function message(text: string, o: MessageOptions = {}): Promise<string> {
    const ok = o.buttons?.ok || t`OK`
    const cancel = o.buttons?.cancel || undefined
    const extra = o.buttons?.extra || undefined
    return request<string>(
        (resolve) => ({
            type: 'message',
            title: o.title ?? 'Rclone UI',
            message: text,
            kind: o.kind ?? 'info',
            buttons: { ok, cancel, extra },
            destructive: o.destructive,
            resolve,
        }),
        cancel ?? '',
        o.signal
    )
}

/**
 * Asks a question with an OK and a Cancel button ("OK" and "Cancel" unless named). Resolves true
 * when the user chose OK. Escape and closing choose Cancel.
 */
export function ask(text: string, o: AskOptions = {}): Promise<boolean> {
    const ok = o.okLabel || t`OK`
    return request<boolean>(
        (resolve) => ({
            type: 'message',
            title: o.title ?? 'Rclone UI',
            message: text,
            kind: o.kind ?? 'info',
            buttons: { ok, cancel: o.cancelLabel || t`Cancel` },
            destructive: o.destructive,
            resolve: (label) => resolve(label === ok),
        }),
        false,
        o.signal
    )
}

/**
 * Asks for a line of text, or null when cancelled. `sensitive` hides the text, for passwords.
 * `signal` closes the prompt when it aborts, which resolves null.
 */
export function prompt(options: {
    title: string
    message: string
    default?: string
    sensitive?: boolean
    signal?: AbortSignal
}): Promise<string | null> {
    return request<string | null>(
        (resolve) => ({
            type: 'prompt',
            title: options.title,
            message: options.message,
            defaultValue: options.default ?? '',
            sensitive: options.sensitive ?? false,
            resolve,
        }),
        null,
        options.signal
    )
}

/**
 * Asks one of rclone's config questions (a backend option) in the field that the remote forms
 * use, and resolves with the answer as rclone reads it: text, "true" or "false" for a switch, or
 * the chosen value. It resolves null when cancelled, or when `signal` aborts. `notice` is
 * rclone's reason for asking again, such as a wrong code, and shows above the field.
 */
export function askOption(
    option: Option,
    notice?: string,
    signal?: AbortSignal
): Promise<string | null> {
    return request<string | null>(
        (resolve) => ({
            type: 'option',
            title: t`Configure remote`,
            message: option.help.trim() || option.name,
            notice: notice ?? '',
            option,
            resolve,
        }),
        null,
        signal
    )
}

/**
 * The answer that a script gives to a dialog in a development run (RCUI_DEV_EVAL): "ok",
 * "cancel", "extra" or "text:<value>", read from the eval folder's answers file. It is null when
 * no script answers, and always null in a release build, which has no DevService. The dialog then
 * waits for the user.
 */
export async function scriptedAnswer(
    title: string,
    text: string,
    isPrompt: boolean
): Promise<string | null> {
    if (flag('production', false)) return null
    try {
        return await DevService.Scripted(title, text, isPrompt)
    } catch {
        return null
    }
}

/**
 * A file type that the Open and Save panels offer, in the Wails runtime's shape: a name such as
 * "JSON" and a pattern such as "*.json", with several patterns separated by semicolons.
 */
export interface FileFilter {
    DisplayName: string
    Pattern: string
}

export interface OpenOptions {
    directory?: boolean
    multiple?: boolean
    title?: string
    defaultPath?: string
    filters?: FileFilter[]
}

/** Lets the user pick files or folders. Resolves null when cancelled. */
export function open(options: OpenOptions & { multiple: true }): Promise<string[] | null>
export function open(options?: OpenOptions & { multiple?: false }): Promise<string | null>
export function open(options?: OpenOptions): Promise<string | string[] | null>
export async function open(options: OpenOptions = {}): Promise<string | string[] | null> {
    const picked = await Dialogs.OpenFile({
        CanChooseDirectories: Boolean(options.directory),
        CanChooseFiles: !options.directory,
        CanCreateDirectories: true,
        AllowsMultipleSelection: Boolean(options.multiple),
        Title: options.title,
        Directory: dialogFolder(options.defaultPath),
        Filters: options.filters,
    })
    if (Array.isArray(picked)) return picked.length > 0 ? picked : null
    return picked || null
}

export interface SaveOptions {
    title?: string
    /** The file name to suggest, or a full path, whose folder the panel then opens in. */
    defaultPath?: string
    filters?: FileFilter[]
}

/**
 * The folder that a file dialog opens in. When the page names none, Windows would open the app's
 * working folder: its install folder, or System32 when a task started it. So it opens the user's
 * home there instead. macOS and Linux keep their own choice, the last folder used.
 */
function dialogFolder(directory: string | undefined): string | undefined {
    if (directory) return directory
    return isWindows() ? homeDir() || undefined : undefined
}

/** Splits a suggested path into the folder that the Save panel opens in and the name it shows. */
function splitDefaultPath(path = ''): { directory: string; filename: string } {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    if (cut < 0) return { directory: '', filename: path }
    return { directory: path.slice(0, cut) || path.slice(0, 1), filename: path.slice(cut + 1) }
}

/**
 * Lets the user pick where to save, and resolves with the path, or null when cancelled. The page
 * then hands the path to the core, which writes there (a Commander download, a config export).
 */
export async function save(options: SaveOptions = {}): Promise<string | null> {
    const { directory, filename } = splitDefaultPath(options.defaultPath)
    const path = await Dialogs.SaveFile({
        Title: options.title,
        Directory: dialogFolder(directory),
        Filename: filename || undefined,
        Filters: options.filters,
        CanCreateDirectories: true,
    })
    return path || null
}

/**
 * Lets the user pick where to save, and writes `contents` there, readable only by the user. It
 * resolves with the path, or null when cancelled. The app writes the file itself, so a page can
 * only write where the user just chose.
 */
export async function saveText(
    contents: string,
    options: SaveOptions = {}
): Promise<string | null> {
    const { directory, filename } = splitDefaultPath(options.defaultPath)
    const path = await DialogService.SaveText(
        {
            title: options.title ?? '',
            directory: dialogFolder(directory) ?? '',
            filename,
            filters: options.filters ?? [],
        },
        contents
    )
    return path || null
}

// ---------------------------------------------------------------------------------------------
// Clipboard and opening things

export const clipboard = {
    setText: (text: string): Promise<void> => Clipboard.SetText(text),
}

/** Opens a URL in the default browser. Under an AppImage, it runs in the host's environment. */
export async function openUrl(url: string | URL): Promise<void> {
    await SystemService.OpenURL(String(url))
}

/** Shows a file or folder in the file manager, selected. */
export async function revealPath(path: string): Promise<void> {
    await SystemService.RevealPath(path)
}

// ---------------------------------------------------------------------------------------------
// Autostart

export const autostart = {
    get: (): Promise<boolean> => SystemService.Autostart(),
    /** Every window then hears `autostart:changed`. */
    set: (on: boolean): Promise<void> => SystemService.SetAutostart(on),
    /** Calls back when a window turned starting at login on or off. */
    onChanged(callback: (on: boolean) => void): Unlisten {
        return Events.On('autostart:changed', (event) => callback(event.data))
    },
}

// ---------------------------------------------------------------------------------------------
// The app's life

/** Quits through the app's quit flow, which asks first when something is running. */
export async function quit(): Promise<void> {
    await SystemService.Quit()
}

/**
 * Restarts the app and reopens the window at `open` (a route). Whatever is running stops and
 * comes back, as after a quit. It asks first when something is running, and resolves false when
 * the user chose to keep the app running.
 */
export function relaunch(open = ''): Promise<boolean> {
    return SystemService.Relaunch(open)
}

// ---------------------------------------------------------------------------------------------
// The core's status. The core runs in the app's process, and pages call it through lib/core.

export const core = {
    /** Calls back with the core's status now, then on every change. */
    onState(callback: (status: CoreStatus) => void): Unlisten {
        let live = true
        // Status() and the events can arrive in any order. Once an event has arrived, the result
        // of Status() may be older than it, so it is ignored.
        let heard = false
        const off = Events.On('core:state', (event) => {
            heard = true
            callback(event.data)
        })
        CoreService.Status()
            .then((status) => {
                if (live && !heard) callback(status)
            })
            .catch(() => undefined)
        return () => {
            live = false
            off()
        }
    },
}

// ---------------------------------------------------------------------------------------------
// Logs. Console lines are written to the app's log file (<data>/logs/rcui.log).

const consoleMethods = ['log', 'debug', 'info', 'warn', 'error'] as const
// A release build logs at Info, and SystemService.Log writes `log` and `debug` at Debug. If they
// were forwarded, each would cost a call and then be dropped.
const releaseConsoleMethods = ['info', 'warn', 'error'] as const
let consoleForwarded = false

function stringify(value: unknown): string {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.stack ?? value.message
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

/**
 * Copies this window's console into the app's log. This is how a page's failures reach
 * rcui.log: the error boundary, the handlers below and the `[boot]` line all write to it through
 * the console.
 */
export function forwardConsole(): void {
    if (consoleForwarded) return
    consoleForwarded = true
    const name = windowName()
    const methods = flag('production', false) ? releaseConsoleMethods : consoleMethods
    for (const method of methods) {
        const original = console[method].bind(console)
        console[method] = (...args: unknown[]) => {
            original(...args)
            SystemService.Log(method, name, args.map(stringify).join(' ')).catch(() => undefined)
        }
    }
    // Uncaught errors reach the log too, so a page that fails to load leaves its reason there.
    window.addEventListener('error', (e) => console.error('[uncaught]', e.message, e.error))
    window.addEventListener('unhandledrejection', (e) => console.error('[unhandled]', e.reason))
}

// ---------------------------------------------------------------------------------------------
// Launcher

export const launcher = {
    /** The shortcut to use when the user never recorded one. */
    defaultShortcut: (): string => flag('defaultShortcut', 'CmdOrCtrl+Shift+/'),
    show: (): Promise<void> => LauncherService.Show(),
    /**
     * Registers the global shortcut ("Command+Shift+/"). undefined or "" removes it. If the OS
     * refuses the shortcut, this rejects and keeps the previous one, so Settings only saves after
     * this succeeds.
     */
    setShortcut: (shortcut?: string): Promise<void> => LauncherService.SetShortcut(shortcut ?? ''),
}

/** A key that the launcher's page leaves to the launcher (see linux.PageService.Key in Go). */
export type LauncherKey = 'up' | 'down' | 'enter' | 'esc' | 'tab' | 'actions' | 'row'

/** Sends a call that answers nothing. A failure only goes to the log. */
function fire(call: Promise<unknown>) {
    call.catch((error: unknown) => console.error('[launcher page]', error))
}

/**
 * The launcher's page, which draws the launcher on Linux (src/pages/Launcher). It reports what
 * the user does, and hears what to draw from the launcher's window alone. The launcher is native
 * on macOS and Windows.
 */
export const launcherPage = {
    ready: (): Promise<LauncherInit> => LauncherPageService.Ready(),
    query: (text: string, seq: number) => fire(LauncherPageService.Query(text, seq)),
    key: (key: LauncherKey, char = '') => fire(LauncherPageService.Key(key, char)),
    hover: (row: number) => fire(LauncherPageService.Hover(row)),
    click: (row: number) => fire(LauncherPageService.Click(row)),
    scroll: (rows: number) => fire(LauncherPageService.Scroll(rows)),
    stopAll: () => fire(LauncherPageService.StopAll()),
    pressed: (down: boolean) => fire(LauncherPageService.Pressed(down)),
    dragOver: (over: boolean) => fire(LauncherPageService.DragOver(over)),
    dragStart: (x: number, y: number) => fire(LauncherPageService.DragStart(x, y)),
    dragMove: (x: number, y: number) => fire(LauncherPageService.DragMove(x, y)),
    dragEnd: () => fire(LauncherPageService.DragEnd()),
    onRender(callback: (frame: LauncherFrame) => void): Unlisten {
        return Events.On('launcher:render', (event) => callback(event.data))
    },
    onQuery(callback: (query: LauncherQuery) => void): Unlisten {
        return Events.On('launcher:query', (event) => callback(event.data))
    },
    onShown(callback: () => void): Unlisten {
        return Events.On('launcher:shown', () => callback())
    },
    onHidden(callback: () => void): Unlisten {
        return Events.On('launcher:hidden', () => callback())
    },
}

// ---------------------------------------------------------------------------------------------
// Updates

export const updater = {
    /**
     * Whether this install updates itself, and if not, why (Flatpak, packages). A portable copy
     * doesn't, but still checks (`manual`): the user downloads a release from its page.
     */
    available: (): Promise<UpdateAvailability> => UpdateService.Available(),
    /** A newer release, or null when the app is current. */
    check: (): Promise<UpdateRelease | null> => UpdateService.Check(),
    /**
     * Downloads and installs the update. After the download, the app asks first if something is
     * running, then stops the core and relaunches.
     */
    install: (): Promise<void> => UpdateService.Install(),
    onState(callback: (state: UpdateState) => void): Unlisten {
        return Events.On('update:state', (event) => callback(event.data))
    },
}

// ---------------------------------------------------------------------------------------------
// rclone on PATH

export const pathLink = {
    status: (): Promise<PathLinkState> => PathService.Status(),
    /**
     * Asks for an administrator password first when `needsAdmin` (macOS). Enable and disable
     * tell every window the new state with `pathlink:changed`.
     */
    enable: (): Promise<PathLinkState> => PathService.Enable(),
    disable: (): Promise<PathLinkState> => PathService.Disable(),
    /** Calls back with the link's state after a window turned it on or off. */
    onChanged(callback: (state: PathLinkState) => void): Unlisten {
        return Events.On('pathlink:changed', (event) => callback(event.data))
    },
}

// ---------------------------------------------------------------------------------------------
// AI agents

/**
 * The MCP server that lets AI agents use the app (core/agents). The settings turn it on and off,
 * and give it its port and a new token. Its status says whether it runs and where, or why it
 * didn't start. `command` is this app's executable: an agent app that starts its MCP servers as
 * commands runs it as `<command> mcp`.
 */
export const agents = {
    status: (): Promise<AgentsInfo> => AgentsService.Status(),
    /**
     * Calls back with the server's status each time it starts, stops or fails to start. The
     * status has no `command`, which doesn't change.
     */
    onChanged(callback: (status: AgentsStatus) => void): Unlisten {
        return Events.On('agents:changed', (event) => callback(event.data))
    },
}
