// The single parser for path strings, following rclone's own rules (`Parse` in
// `fs/fspath/path.go`). It is stateless: no list of remotes and no I/O. Whether a string is a
// remote path depends only on its shape:
//   - With no `:` anywhere, it is local.
//   - With a `/` or `\` before the first `:` or `,`, it is local (`/tmp/10:30.txt`).
//   - Otherwise the prefix before that `:` or `,` is the remote name, and it must follow rclone's
//     rule for names (letters, digits, `_ . + @`, and spaces and dashes inside the name). A `,`
//     starts connection-string parameters, which run to the next unquoted `:`.
//   - On a Windows host only, a single-letter name is a drive, so the path is local (`C:`,
//     `c:photos`).
//   - On a Windows host only, `\` in a path is a separator (rclone's `filepath.ToSlash`).
//     Elsewhere it is part of a name, so `/tmp/a\b.txt` is one file in /tmp.
//   - The path after the colon is kept exactly as typed. A leading slash is kept, because on sftp
//     and on the local backend it makes the path absolute, and the backends where it means nothing
//     trim it themselves. Nothing here adds a slash that the user didn't type, or removes one.
//   - A local path that isn't full (`tmp`, `~/x`, `:local:x`) is rejected (`pathProblem`),
//     because rclone would resolve it from the core's working directory.
// The only context needed is whether the host is Windows, which the app knows without I/O
// (`isWindows` in lib/shell). `:/` has no special meaning.

import { t } from '@lingui/core/macro'
import { isWindows } from './shell'

export type Host = { windows: boolean }
export const POSIX: Host = { windows: false }
export const WINDOWS: Host = { windows: true }

/** The host that the core runs on, which is this machine. Pure code and tests pass a host. */
export const currentHost = (): Host => (isWindows() ? WINDOWS : POSIX)

type InvalidCode = 'empty' | 'name' | 'on-the-fly' | 'params'

export type Parsed =
    | { kind: 'local'; path: string }
    /** `name` keeps a leading `:` for an on-the-fly backend (`:local`, `:sftp`). */
    | { kind: 'remote'; name: string; params: string; path: string }
    /** A path that rclone would reject. `reason` is rclone's wording. `code` picks the message. */
    | { kind: 'invalid'; code: InvalidCode; reason: string }

// rclone: `[\w\p{L}\p{N}.+@]+(?:[ -]+[\w\p{L}\p{N}.+@-]+)*` (Go's \w is [0-9A-Za-z_]).
const NAME = /^[\p{L}\p{N}_.+@]+(?:[ -]+[\p{L}\p{N}_.+@-]+)*$/u
const DRIVE_LETTER = /^[a-zA-Z]$/
const CONFIG_PARAM = /^[\w.]$/
const SEPARATOR = /[/\\]/
const LEADING_SEPARATOR = /^[/\\]/
const SLASH = /\//
const LEADING_SLASH = /^\//
const WINDOWS_DRIVE = /^([a-zA-Z]:)[/\\]?/
const NAME_END = /[:,]/

// The separators in a path after a remote's colon, and in a local path. rclone turns `\` into `/`
// on a Windows host only (`filepath.ToSlash`). Elsewhere a backslash is part of a name.
export const separatorOf = (host: Host) => (host.windows ? SEPARATOR : SLASH)
export const leadingSeparatorOf = (host: Host) => (host.windows ? LEADING_SEPARATOR : LEADING_SLASH)

const TRAILING_SEPARATORS = /[/\\]+$/
const TRAILING_SLASHES = /\/+$/

/** The separators at the end of a path. A backslash is one on a Windows host only. */
export const trailingSeparatorsOf = (host: Host) =>
    host.windows ? TRAILING_SEPARATORS : TRAILING_SLASHES

// Drives only exist on a Windows host. Callers that test these have already checked the host.
/** A drive on its own: `C:`, `C:\`, `C:/`. */
export const DRIVE_ROOT = /^[a-zA-Z]:[/\\]?$/
/** A path from a drive's root: `C:\…`, `C:/…`. */
export const DRIVE_PREFIX = /^[a-zA-Z]:[/\\]/
/** A share on its own: `\\server\share`, with or without a separator after it. */
export const SHARE_ROOT = /^[/\\]{2}[^/\\]+[/\\][^/\\]+[/\\]?$/
/**
 * A path from a share's root. It captures the server and the share, which together are the volume
 * in rclone's local backend.
 */
const SHARE_PREFIX = /^[/\\]{2}([^/\\]+)[/\\]([^/\\]+)/

const invalid = (code: InvalidCode, reason: string): Parsed => ({ kind: 'invalid', code, reason })

/**
 * Finds where the connection-string parameters that start at `from` (a `,`) end, and returns the
 * index of the `:`. Returns an invalid result when the parameters are malformed.
 */
function scanParams(input: string, from: number): number | Parsed {
    let state: 'param' | 'value' | 'quoted' | 'afterQuote' = 'param'
    let prev = from + 1
    let quote = ''
    for (let i = from + 1; i < input.length; i++) {
        const c = input[i]
        switch (state) {
            case 'param':
                if (c === ':' || c === ',' || c === '=') {
                    if (i === prev) return invalid('params', "config parameters can't be empty")
                    prev = i + 1
                    if (c === '=') state = 'value'
                    else if (c === ':') return i
                } else if (!CONFIG_PARAM.test(c)) {
                    return invalid(
                        'params',
                        'config parameters may only contain `0-9`, `A-Z`, `a-z`, `_` and `.`'
                    )
                }
                break
            case 'value':
                if ((c === '"' || c === "'") && i === prev) {
                    quote = c
                    state = 'quoted'
                } else if (c === ':') return i
                else if (c === ',') {
                    prev = i + 1
                    state = 'param'
                }
                break
            case 'quoted':
                if (c === quote) state = 'afterQuote'
                break
            case 'afterQuote': {
                if (c === ':') return i
                if (c === ',') {
                    prev = i + 1
                    state = 'param'
                } else if (c === quote) state = 'quoted'
                else return invalid('params', 'expecting `:` or `,` or another quote after a quote')
                break
            }
        }
    }
    return invalid(
        'params',
        state === 'param'
            ? 'config parameter must end with `,` or `:`'
            : state === 'quoted'
              ? 'unterminated quoted config value'
              : 'unquoted config value must end with `,` or `:`'
    )
}

/** rclone's `fspath.Parse` without the config map: the name, the raw parameters and the path. */
export function parsePath(input: string, host: Host = currentHost()): Parsed {
    if (input === '') return invalid('empty', "can't use empty string as a path")
    if (!input.includes(':')) return { kind: 'local', path: input }
    for (let i = 0; i < input.length; i++) {
        const c = input[i]
        if (i === 0 && c === ':') continue
        if (c === '/' || c === '\\') {
            // A separator before any `:` makes the path local, unless it was meant as an
            // on-the-fly remote (`:sftp/x`), which rclone rejects instead of guessing.
            if (input[0] === ':') {
                return invalid('on-the-fly', 'config name contains invalid characters')
            }
            return { kind: 'local', path: input }
        }
        if (c !== ':' && c !== ',') continue
        const name = input.slice(0, i)
        const bare = name.startsWith(':') ? name.slice(1) : name
        if (!NAME.test(bare)) return invalid('name', 'config name contains invalid characters')
        if (c === ':') {
            if (host.windows && DRIVE_LETTER.test(name)) return { kind: 'local', path: input }
            return { kind: 'remote', name, params: '', path: input.slice(i + 1) }
        }
        const end = scanParams(input, i)
        if (typeof end !== 'number') return end
        return { kind: 'remote', name, params: input.slice(i, end), path: input.slice(end + 1) }
    }
    return invalid('name', 'config name needs a trailing `:`')
}

/** A drive path (`C:\…`) on a host without drives, which rclone would read as the remote `C`. */
function driveOnOtherHost(parsed: Parsed, host: Host) {
    return (
        !host.windows &&
        parsed.kind === 'remote' &&
        DRIVE_LETTER.test(parsed.name) &&
        LEADING_SEPARATOR.test(parsed.path)
    )
}

/**
 * Whether a local path names the same place whatever the core's working directory is. That means
 * it starts with `/`, or on a Windows host, with a separator (a share, or the current drive's
 * root) or a drive's root. A drive without a separator after it (`C:`, `C:photos`) means that
 * drive's current folder, which rclone resolves from the core's working directory on that drive.
 */
function isFullLocal(path: string, host: Host): boolean {
    return host.windows
        ? LEADING_SEPARATOR.test(path) || DRIVE_PREFIX.test(path)
        : path.startsWith('/')
}

/** The local path that a parsed path names, including the local backend's form (`:local:x`). */
function localPathOf(parsed: Parsed): string | undefined {
    if (parsed.kind === 'local') return parsed.path
    if (parsed.kind === 'remote' && parsed.name === ':local') return parsed.path
    return undefined
}

/**
 * Explains why a typed path can't be sent as is, or returns undefined. It reports what rclone
 * would reject, and also what rclone would accept but not read as intended: a Windows drive path
 * on a host without drives, and a local path that isn't full (`tmp`, `./x`, `~/x`, `:local:x`),
 * which rclone resolves from the core's working directory. An empty string isn't reported,
 * because the pages ask for a path themselves.
 */
export function pathProblem(input: string, host: Host = currentHost()): string | undefined {
    const parsed = parsePath(input, host)
    if (parsed.kind === 'invalid') {
        switch (parsed.code) {
            case 'empty':
                return undefined
            case 'name': {
                const name = input.slice(0, input.search(NAME_END))
                return t`‘${name}’ cannot be a remote name. A name may contain letters, digits, spaces and _ - . + @, and cannot start with - or a space.`
            }
            case 'on-the-fly':
                return t`An on-the-fly remote needs a colon after its type, as in :sftp:path.`
            case 'params':
                return t`The remote’s options are not finished. End them with a colon, as in remote,option=value:path.`
        }
    }
    if (driveOnOtherHost(parsed, host) && parsed.kind === 'remote') {
        const name = parsed.name
        return t`This host is not Windows, so ${name}: would be read as a remote called ${name}. Use a path that starts with /.`
    }
    const local = localPathOf(parsed)
    if (local !== undefined && !isFullLocal(local, host)) {
        return host.windows
            ? t`This is not a full path. Use one that starts with a drive, as in C:\\.`
            : t`This is not a full path. Use one that starts with /.`
    }
    return undefined
}

/** The problem with the first of several paths that can't be sent, as `pathProblem` words it. */
export function pathsProblem(
    paths: (string | undefined)[],
    host: Host = currentHost()
): string | undefined {
    for (const path of paths) {
        const problem = path ? pathProblem(path, host) : undefined
        if (problem) return problem
    }
    return undefined
}

/** Builds a full path from its parts, never adding a slash that the user didn't type. */
export function formatRemote(name: string, path: string) {
    return `${name}:${path}`
}

/**
 * Joins a name onto a remote directory, in the form the panel keeps it: `` + `b` → `b`,
 * `/` + `b` → `/b`, and `a` + `b` → `a/b`. A backslash is a separator on a Windows host only.
 */
export function joinRemoteDir(dir: string, name: string, host: Host = currentHost()): string {
    const absolute = leadingSeparatorOf(host).test(dir)
    const parts = dir.split(separatorOf(host)).filter(Boolean)
    return `${absolute ? '/' : ''}${[...parts, name].join('/')}`
}

/**
 * The folder above a remote directory, in the form the panel keeps it (the part after the colon):
 * `/a/b` → `/a` → `/` → `/`, because an absolute root has nothing above it, and
 * `a/b` → `a` → `` → ``. On sftp the two roots are different places (the machine's `/` and the
 * login directory), so neither turns into the other. A backslash is a separator on a Windows
 * host only.
 */
export function remoteParentDir(dir: string, host: Host = currentHost()): string {
    const absolute = leadingSeparatorOf(host).test(dir)
    const parts = dir.split(separatorOf(host)).filter(Boolean)
    parts.pop()
    return `${absolute ? '/' : ''}${parts.join('/')}`
}

/**
 * The last name in a path, as rclone reads it. It is `b.txt` for `remote:a/b.txt`, for
 * `/tmp/b.txt`, and for `C:\tmp\b.txt` on Windows. On other hosts it is `a\b.txt` for
 * `/tmp/a\b.txt`. A root has no last name, so the result is ''.
 */
export function baseName(input: string, host: Host = currentHost()): string {
    const parsed = parsePath(input, host)
    let path = parsed.kind === 'invalid' ? input : parsed.path
    if (parsed.kind === 'local' && host.windows) path = path.replace(WINDOWS_DRIVE, '')
    return path.split(separatorOf(host)).filter(Boolean).pop() ?? ''
}

/**
 * A path as typed, shortened to `<first>/.../<parent>/<name>` when it is long. For a remote, the
 * prefix is its name and the slash it had, if any. For a local path, the prefix is its root
 * (`/`, `C:/`). A backslash is a separator on a Windows host only.
 */
export function readablePath(input: string, host: Host = currentHost()): string {
    const parsed = parsePath(input, host)
    if (parsed.kind === 'invalid') return input
    let prefix: string
    let rest: string
    if (parsed.kind === 'remote') {
        const slash = leadingSeparatorOf(host).test(parsed.path) ? '/' : ''
        prefix = `${parsed.name}${parsed.params}:${slash}`
        rest = parsed.path
    } else {
        const drive = host.windows ? parsed.path.match(WINDOWS_DRIVE) : null
        prefix = drive ? `${drive[1]}/` : '/'
        rest = drive ? parsed.path.slice(drive[0].length) : parsed.path
    }
    const segments = rest.split(separatorOf(host)).filter(Boolean)
    const body =
        segments.length <= 3
            ? segments.join('/')
            : `${segments[0]}/.../${segments[segments.length - 2]}/${segments[segments.length - 1]}`
    return `${prefix}${body}`
}

// --- Local paths ----------------------------------------------------------------------------
// Path arithmetic for local paths, by host, following how rclone's local backend reads them. On a
// Windows host, a drive (`C:\`) or a share (`\\nas\share\`, filepath.VolumeName) is a root, just
// like `/`. A root keeps its separator, and nothing goes above a root.

/** Splits a local path into its root, written with the host's separator, and the names after it. */
function splitLocal(path: string, host: Host): { root: string; names: string[] } {
    let root = ''
    let rest = path
    const share = host.windows ? SHARE_PREFIX.exec(path) : null
    const drive = host.windows && !share ? WINDOWS_DRIVE.exec(path) : null
    if (share) {
        root = `\\\\${share[1]}\\${share[2]}\\`
        rest = path.slice(share[0].length)
    } else if (drive) {
        root = `${drive[1]}\\`
        rest = path.slice(drive[0].length)
    } else if (leadingSeparatorOf(host).test(path)) {
        root = host.windows ? '\\' : '/'
    }
    return { root, names: rest.split(separatorOf(host)).filter(Boolean) }
}

const localSeparator = (host: Host) => (host.windows ? '\\' : '/')

/** The root that a local path starts at (`/`, `C:\`, `\\nas\share\`), or '' for a bare name. */
export function localRoot(path: string, host: Host = currentHost()): string {
    return splitLocal(path, host).root
}

/**
 * The folder above a local path: `/a/b` → `/a` → `/`, `C:\a` → `C:\`, and `\\nas\share\a` →
 * `\\nas\share\`. A root is its own parent, so a panel's BACK stops there. A bare name's parent
 * is ''.
 */
export function localParentDir(path: string, host: Host = currentHost()): string {
    const { root, names } = splitLocal(path, host)
    if (names.length === 0) return root ? path : ''
    names.pop()
    return root + names.join(localSeparator(host))
}

/**
 * Joins a name onto a local folder: `/tmp` + `x` → `/tmp/x`, `\\nas\share` + `x` → `\\nas\share\x`.
 */
export function joinLocalDir(dir: string, name: string, host: Host = currentHost()): string {
    const { root, names } = splitLocal(dir, host)
    return root + [...names, name].join(localSeparator(host))
}

/**
 * The names along a local path, for the breadcrumb. On a Windows host, a drive (`C:`) or a share
 * (`\\nas\share`) comes first, as one segment. The root `/` adds no segment.
 */
export function localSegments(path: string, host: Host = currentHost()): string[] {
    const { root, names } = splitLocal(path, host)
    const volume = root.length > 1 ? root.slice(0, -1) : ''
    return volume ? [volume, ...names] : names
}

/** Whether a breadcrumb's first segment is a volume, meaning a drive or share on a Windows host. */
function isVolume(segment: string | undefined, host: Host): segment is string {
    return !!segment && host.windows && (DRIVE_ROOT.test(segment) || SHARE_ROOT.test(segment))
}

/**
 * The absolute local path that a list of breadcrumb segments names (`localSegments`). On POSIX
 * it is `/a/b`. On Windows the volume comes first (`C:\a\b`, `\\nas\share\a`, and `C:\` for the
 * drive alone). An empty list means the root.
 */
export function joinLocalSegments(segments: string[], host: Host = currentHost()): string {
    const [first, ...rest] = segments
    const sep = localSeparator(host)
    if (isVolume(first, host)) {
        return `${first.replace(trailingSeparatorsOf(host), '')}${sep}${rest.join(sep)}`
    }
    return sep + segments.join(sep)
}

/** Where the breadcrumb's Local button goes: the path's drive or share on Windows, else `/`. */
export function localRootOf(segments: string[], host: Host = currentHost()): string {
    const first = segments[0]
    return joinLocalSegments(isVolume(first, host) ? [first] : [], host)
}

/** The config name (`gdrive`) of a remote as the panels keep it (`gdrive,shared_with_me`). */
export function configNameOf(remote: string): string {
    const comma = remote.indexOf(',')
    return comma === -1 ? remote : remote.slice(0, comma)
}

/**
 * A picked folder as the `remote` option of a backend that wraps another remote (an alias's or a
 * crypt's): `remote:path` or a local folder, without trailing separators. A root keeps its
 * separator: `gdrive:/` is the absolute root on sftp, and on Windows `C:` alone would be the
 * drive's current folder.
 */
export function toWrappedRemote(path: string, host: Host = currentHost()): string {
    const parsed = parsePath(path, host)
    const trailing = trailingSeparatorsOf(host)
    if (parsed.kind === 'remote') {
        const trimmed = parsed.path.replace(trailing, '')
        const rest = trimmed === '' && leadingSeparatorOf(host).test(parsed.path) ? '/' : trimmed
        return `${parsed.name}${parsed.params}:${rest}`
    }
    const trimmed = path.replace(trailing, '')
    return trimmed === '' || (host.windows && DRIVE_ROOT.test(trimmed)) ? path : trimmed
}

/**
 * The folder that a local file picker opens at, for a field's current value: the folder itself,
 * or the folder of a file. Undefined when there is no value, so the picker opens where it likes.
 */
export function pickerStart(
    value: string | undefined,
    directory: boolean,
    host: Host = currentHost()
): string | undefined {
    const current = value?.trim()
    if (!current) return undefined
    if (directory) return current
    return localParentDir(current, host) || undefined
}
