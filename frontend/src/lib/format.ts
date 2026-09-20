import { type Host, currentHost, fsOf, parsePath, pathProblem, readablePath } from './paths'

const RE_WINDOWS_DRIVE = /^[a-zA-Z]:([/\\]|$)/
const RE_PATH_SEPARATOR = /[/\\]/

export function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes)) return '0 B'

    if (bytes < 1024) {
        return `${Math.round(bytes)} B`
    }

    if (bytes < 1024 * 1024) {
        return `${Number.parseFloat((bytes / 1024).toFixed(2))} KB`
    }

    if (bytes < 1024 * 1024 * 1024) {
        return `${Number.parseFloat((bytes / 1024 / 1024).toFixed(2))} MB`
    }

    return `${Number.parseFloat((bytes / 1024 / 1024 / 1024).toFixed(2))} GB`
}

export function replaceSmartQuotes(value: string) {
    const replacements: { [key: string]: string } = {
        '‘': "'",
        '’': "'",
        '‚': "'",
        '“': '"',
        '”': '"',
        '„': '"',
    }
    return value.replace(/[‘’‚“”„]/g, (match) => replacements[match])
}

/**
 * The remote a path names, or null for a local path and for what rclone would refuse. The one
 * grammar is `lib/paths.ts` (rclone's own): `:local` for the local backend spelled as a remote,
 * a drive letter on a Windows host is local, and a colon inside a file name is no remote.
 */
export function getRemoteName(path?: string, host: Host = currentHost()) {
    if (!path) return null
    const parsed = parsePath(path, host)
    return parsed.kind === 'remote' ? parsed.name : null
}

/**
 * The paths of a selection that name a configured remote, in order and with duplicates kept.
 * Local paths (and `:local:`, which is the local backend spelled as a remote) name none, so an
 * operation between two of them has no per-remote backend options to offer at all; neither
 * does a path that cannot be sent (`pathProblem`), which the field is already saying.
 */
export function pathsWithRemote(paths: (string | undefined | null)[], host: Host = currentHost()) {
    return paths.filter((path): path is string => {
        const remote = path ? getRemoteName(path, host) : null
        return !!remote && remote !== ':local' && !pathProblem(path!, host)
    })
}

/**
 * The value a wrapper backend's `remote` option takes for a path picked in the file panel: the
 * path as browsed, minus a trailing separator (a bare `remote:` for the root). A leading slash
 * is the user's — absolute on backends such as sftp — and stays. Local folders keep their
 * absolute form.
 */
export function toWrappedRemote(path: string, host: Host = currentHost()): string {
    const parsed = parsePath(path, host)
    if (parsed.kind === 'remote') {
        const trimmed = parsed.path.replace(/[/\\]+$/, '')
        // The absolute root keeps its one slash: it is the whole of what was said.
        const rest = trimmed === '' && /^[/\\]/.test(parsed.path) ? '/' : trimmed
        return `${parsed.name}${parsed.params}:${rest}`
    }
    const trimmed = path.replace(/[/\\]+$/, '')
    // A filesystem root (`/`, `C:\`) keeps its separator: `C:` alone would name a remote.
    return trimmed === '' || /^[a-zA-Z]:$/.test(trimmed) ? path : trimmed
}

/**
 * The absolute local path a run of breadcrumb segments names: `/a/b` on POSIX; on Windows the
 * drive leads (`C:\\a\\b`, and `C:\\` for the drive alone). No segments is the root.
 */
/** The local path separator of a machine by its OS: the host's, not the one serving the page. */
export function separatorForOs(os: string | undefined): '/' | '\\' {
    return os === 'windows' ? '\\' : '/'
}

export function joinLocalSegments(segments: string[], sep: string): string {
    const [first, ...rest] = segments
    if (sep === '\\' && first && RE_WINDOWS_DRIVE.test(first)) {
        return `${first}\\${rest.join('\\')}`
    }
    return sep + segments.join(sep)
}

/** Where the breadcrumb's Local button goes: the path's own drive root on Windows, else `/`. */
export function localRootOf(segments: string[], sep: string): string {
    const first = segments[0]
    return joinLocalSegments(
        sep === '\\' && first && RE_WINDOWS_DRIVE.test(first) ? [first] : [],
        sep
    )
}

/**
 * A path as typed: `short` is its last segment, `long` the whole thing abbreviated in the middle
 * to `<first>/.../<parent>/<name>` (`lib/paths.ts`, `readablePath`). Nothing is added: a
 * remote's slash, or its absence, is the user's.
 */
export function buildReadablePath(path: string, type: 'short' | 'long' = 'long') {
    if (!path) {
        return ''
    }

    if (type === 'short') {
        return path.split(RE_PATH_SEPARATOR).filter(Boolean).pop() ?? ''
    }

    return readablePath(path)
}

export function buildReadablePathMultiple(
    paths: string[],
    type: 'short' | 'long',
    truncate: boolean = false
) {
    if (paths.length < 2) {
        return buildReadablePath(paths[0], type)
    }

    const readablePath = `${buildReadablePath(paths[0], type)} + ${paths.length - 1} more`

    if (truncate) {
        let [start, end] = readablePath.split(' + ')

        if (start.length <= 30) {
            return readablePath
        }

        start = start.slice(0, 47) + '...'

        return `${start} + ${end}`
    }

    return readablePath
}

/**
 * The split every request makes of a path: the fs `root` (`gdrive:`, `gdrive:/`, `:local:/`,
 * `:local:C:/` — a leading slash the user typed stays on the root, where it counts: absolute
 * on sftp and on the local backend), the path under it (`filePath`; `dirPath` with a trailing
 * separator, empty for a root), and what it is: a folder when it ends in a separator or is a
 * root, a file otherwise. Built on `lib/paths.ts`; what rclone would refuse splits as a local
 * path, and `pathProblem` is where that is said.
 */
export function getFsInfo(fs: string, host: Host = currentHost()) {
    const info = fsOf(fs, host) ?? {
        kind: 'local' as const,
        remote: ':local',
        root: ':local:/',
        rel: fs.replace(/^[/\\]+/, '').replace(/[/\\]+$/, ''),
        isFolder: false,
    }
    const path = info.rel
    const dirPath = path ? `${path}/` : ''
    return {
        isRemote: info.kind === 'remote',
        root: info.root,
        filePath: path,
        dirPath,
        fullFilePath: `${info.root}${path}`,
        fullDirPath: `${info.root}${dirPath}`,
        name: path.split('/').pop()!,
        // What the string says of itself: a root, or a trailing separator, reads as a folder.
        // A word, not a decision: whether a source is one is rclone's answer at build time
        // (`kindOf` in `lib/rclone/requests.ts`); this is the hint when there is none, and what
        // `serializeOptions` follows to hand rclone the string with the slash it came with.
        type: (info.isFolder ? 'folder' : 'file') as 'folder' | 'file',
        remoteName: info.remote,
    }
}

/** `old:path` becomes `new:path`; anything else (a local path, another remote) is unchanged. */
export function renameRemoteIn(value: string, from: string, to: string): string {
    return value.startsWith(`${from}:`) ? `${to}:${value.slice(from.length + 1)}` : value
}

interface RenameableArgs {
    sources?: string[]
    source?: string
    destination?: string
    options?: { remotes?: Record<string, unknown> }
}

/**
 * Operation arguments with every mention of a remote renamed: the paths that start with it and
 * its per-remote options. `changed` says whether anything did; the same object comes back
 * when nothing did.
 */
export function renameRemoteInArgs<T extends RenameableArgs>(
    args: T,
    from: string,
    to: string
): { args: T; changed: boolean } {
    let changed = false
    const rename = (value: string) => {
        const next = renameRemoteIn(value, from, to)
        if (next !== value) changed = true
        return next
    }
    const next: RenameableArgs = { ...args }
    if (next.sources) next.sources = next.sources.map(rename)
    if (typeof next.source === 'string') next.source = rename(next.source)
    if (typeof next.destination === 'string') next.destination = rename(next.destination)
    if (next.options?.remotes && from in next.options.remotes) {
        const { [from]: options, ...rest } = next.options.remotes
        next.options = { ...next.options, remotes: { ...rest, [to]: options } }
        changed = true
    }
    return { args: (changed ? next : args) as T, changed }
}
