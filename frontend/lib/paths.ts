// The one grammar for a path string, rclone's own (`fs/fspath/path.go`, `Parse`). It is
// stateless: no remote list, no I/O. A string is a remote path by its shape alone:
//   - no `:` anywhere → local
//   - a `/` or `\` before the first `:` or `,` → local (`/tmp/10:30.txt`)
//   - the prefix before that `:` or `,` is the remote name and must fit rclone's name grammar
//     (letters, digits, `_ . + @`, inner spaces and dashes); `,` opens connection-string
//     parameters up to the next unquoted `:`
//   - on a Windows host only, a single-letter name is a drive → local (`C:`, `c:photos`)
//   - the path after the colon is verbatim. A leading slash is kept: on sftp and on the local
//     backend it makes the path absolute, and the backends where it means nothing trim it
//     themselves. Nothing here adds a slash the user did not type or takes one away.
// The one bit of context is whether the host is Windows, which the app knows without I/O.
// `:/` is not a marker of anything.

export type Host = { windows: boolean }
export const POSIX: Host = { windows: false }
export const WINDOWS: Host = { windows: true }

let hostProvider: () => Host = () => POSIX

/** Set once by the rclone client to the server's OS; pure code passes a host instead. */
export function setHostProvider(provider: () => Host) {
    hostProvider = provider
}

export const currentHost = (): Host => hostProvider()

type InvalidCode = 'empty' | 'name' | 'on-the-fly' | 'params'

export type Parsed =
    | { kind: 'local'; path: string }
    /** `name` keeps a leading `:` for an on-the-fly backend (`:local`, `:sftp`). */
    | { kind: 'remote'; name: string; params: string; path: string }
    /** What rclone would refuse; `reason` is its own wording, `code` what a message keys on. */
    | { kind: 'invalid'; code: InvalidCode; reason: string }

// rclone: `[\w\p{L}\p{N}.+@]+(?:[ -]+[\w\p{L}\p{N}.+@-]+)*` (Go's \w is [0-9A-Za-z_]).
const NAME = /^[\p{L}\p{N}_.+@]+(?:[ -]+[\p{L}\p{N}_.+@-]+)*$/u
const DRIVE_LETTER = /^[a-zA-Z]$/
const CONFIG_PARAM = /^[\w.]$/
const SEPARATOR = /[/\\]/
const LEADING_SEPARATOR = /^[/\\]/
const LEADING_SEPARATORS = /^[/\\]+/
const TRAILING_SEPARATORS = /[/\\]+$/
const WINDOWS_DRIVE = /^([a-zA-Z]:)[/\\]?/

const invalid = (code: InvalidCode, reason: string): Parsed => ({ kind: 'invalid', code, reason })

/** Where the connection-string parameters starting at `from` (a `,`) end: the index of the `:`. */
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
            case 'afterQuote':
                if (c === ':') return i
                if (c === ',') {
                    prev = i + 1
                    state = 'param'
                } else if (c === quote) state = 'quoted'
                else return invalid('params', 'expecting `:` or `,` or another quote after a quote')
                break
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

/** rclone's `fspath.Parse`, minus the config map: the name, the raw parameters, the path. */
export function parsePath(input: string, host: Host = currentHost()): Parsed {
    if (input === '') return invalid('empty', "can't use empty string as a path")
    if (!input.includes(':')) return { kind: 'local', path: input }
    for (let i = 0; i < input.length; i++) {
        const c = input[i]
        if (i === 0 && c === ':') continue
        if (c === '/' || c === '\\') {
            // A separator before any `:` is a local path — unless it was meant as an on-the-fly
            // remote (`:sftp/x`), which rclone refuses rather than guesses.
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

export const isRemote = (input: string, host?: Host) => parsePath(input, host).kind === 'remote'

/** A drive-shaped path (`C:\…`) on a host that has no drives: rclone would read the remote `C`. */
function driveOnOtherHost(parsed: Parsed, host: Host) {
    return (
        !host.windows &&
        parsed.kind === 'remote' &&
        DRIVE_LETTER.test(parsed.name) &&
        LEADING_SEPARATOR.test(parsed.path)
    )
}

/**
 * Why a typed path cannot be sent as it is, or nothing: what rclone would refuse, and the one
 * thing it would accept but not mean (a Windows drive path on a host without drives). An empty
 * string is nothing to say: the pages ask for a path themselves.
 */
export function pathProblem(input: string, host: Host = currentHost()): string | undefined {
    const parsed = parsePath(input, host)
    if (parsed.kind === 'invalid') {
        switch (parsed.code) {
            case 'empty':
                return undefined
            case 'name': {
                const name = input.slice(0, input.search(/[:,]/))
                return `‘${name}’ cannot be a remote name. A name may contain letters, digits, spaces and _ - . + @, and cannot start with - or a space.`
            }
            case 'on-the-fly':
                return 'An on-the-fly remote needs a colon after its type, as in :sftp:path.'
            case 'params':
                return 'The remote’s options are not finished. End them with a colon, as in remote,option=value:path.'
        }
    }
    if (driveOnOtherHost(parsed, host) && parsed.kind === 'remote') {
        return `This host is not Windows, so ${parsed.name}: would be read as a remote called ${parsed.name}. Use a path that starts with /.`
    }
    return undefined
}

/** The first of several paths that cannot be sent, said as `pathProblem` says it. */
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

/**
 * The `fs` + `remote` pair rclone takes for a path, built here and nowhere else. The root
 * carries a leading slash when the path had one (`sftp:/`, like `:local:/` always has), so what
 * the user spelled is what rclone reads; the rest is relative to it. Local paths take the
 * `:local:` backend with an explicit root (`:local:/`, `:local:C:/`), never a bare `:local:`,
 * which is relative to the daemon's working directory. A bare `remote:` or `remote:/` is a
 * folder: a root cannot be a file. Otherwise only a trailing slash says folder.
 */
export function fsOf(input: string, host: Host = currentHost()) {
    const parsed = parsePath(input, host)
    if (parsed.kind === 'invalid') return undefined
    const slashed = (path: string) => path.replace(/\\/g, '/')
    if (parsed.kind === 'remote') {
        const path = slashed(parsed.path)
        const absolute = path.startsWith('/')
        const rel = path.replace(LEADING_SEPARATORS, '').replace(TRAILING_SEPARATORS, '')
        return {
            kind: 'remote' as const,
            remote: parsed.name,
            root: `${parsed.name}${parsed.params}:${absolute ? '/' : ''}`,
            rel,
            isFolder: parsed.path === '' || SEPARATOR.test(parsed.path.slice(-1)),
            /** The whole thing as one fs, for the folder endpoints (`sync/copy`). */
            fs: `${parsed.name}${parsed.params}:${absolute ? '/' : ''}${rel}${rel ? '/' : ''}`,
        }
    }
    const path = slashed(parsed.path)
    const drive = path.match(WINDOWS_DRIVE)
    const root = drive ? `:local:${drive[1]}/` : ':local:/'
    const rel = (drive ? path.slice(drive[0].length) : path)
        .replace(LEADING_SEPARATORS, '')
        .replace(TRAILING_SEPARATORS, '')
    return {
        kind: 'local' as const,
        remote: ':local',
        root,
        rel,
        isFolder: rel === '' || SEPARATOR.test(parsed.path.slice(-1)),
        fs: `${root}${rel}${rel ? '/' : ''}`,
    }
}

/** A full path from its parts, never adding a slash the user did not have. */
export function formatRemote(name: string, path: string) {
    return `${name}:${path}`
}

/** A name under a remote directory as the panel keeps it: `` + `b` → `b`; `/` + `b` → `/b`; `a` + `b` → `a/b`. */
export function joinRemoteDir(dir: string, name: string): string {
    const absolute = LEADING_SEPARATOR.test(dir)
    const parts = dir.split(SEPARATOR).filter(Boolean)
    return `${absolute ? '/' : ''}${[...parts, name].join('/')}`
}

/** `remote:a` + `b` → `remote:a/b`; `remote:` + `b` → `remote:b`; `remote:/` + `b` → `remote:/b`. */
export function joinRemote(parent: string, name: string, host: Host = currentHost()): string {
    const parsed = parsePath(parent, host)
    if (parsed.kind !== 'remote') throw new Error(`not a remote path: ${parent}`)
    return `${parsed.name}${parsed.params}:${joinRemoteDir(parsed.path, name)}`
}

/**
 * The folder above a remote's directory, as the panel keeps it (the part after the colon):
 * `/a/b` → `/a` → `/` → `/` (an absolute root has nothing above it); `a/b` → `a` → `` → ``.
 * The two roots are two places on sftp (the machine's `/` and the login directory), so
 * neither becomes the other.
 */
export function remoteParentDir(dir: string): string {
    const absolute = LEADING_SEPARATOR.test(dir)
    const parts = dir.split(SEPARATOR).filter(Boolean)
    parts.pop()
    return `${absolute ? '/' : ''}${parts.join('/')}`
}

/** `remote:/a/b` → `remote:/a`; `remote:a` → `remote:`; see `remoteParentDir`. */
export function parentRemote(full: string, host: Host = currentHost()): string {
    const parsed = parsePath(full, host)
    if (parsed.kind !== 'remote') throw new Error(`not a remote path: ${full}`)
    return `${parsed.name}${parsed.params}:${remoteParentDir(parsed.path)}`
}

/**
 * A path as typed, abbreviated to `<first>/.../<parent>/<name>` when long. A remote's prefix is
 * its name and whatever slash it had; a local path's is its root (`/`, `C:/`), as before.
 */
export function readablePath(input: string, host: Host = currentHost()): string {
    const parsed = parsePath(input, host)
    if (parsed.kind === 'invalid') return input
    let prefix: string
    let rest: string
    if (parsed.kind === 'remote') {
        prefix = `${parsed.name}${parsed.params}:${LEADING_SEPARATOR.test(parsed.path) ? '/' : ''}`
        rest = parsed.path
    } else {
        const drive = parsed.path.match(WINDOWS_DRIVE)
        prefix = drive ? `${drive[1]}/` : '/'
        rest = drive ? parsed.path.slice(drive[0].length) : parsed.path
    }
    const segments = rest.split(SEPARATOR).filter(Boolean)
    const body =
        segments.length <= 3
            ? segments.join('/')
            : `${segments[0]}/.../${segments[segments.length - 2]}/${segments[segments.length - 1]}`
    return `${prefix}${body}`
}
