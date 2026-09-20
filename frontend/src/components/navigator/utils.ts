import type { LucideIcon } from 'lucide-react'
import {
    DownloadIcon,
    FileTextIcon,
    HardDriveIcon,
    HouseIcon,
    MonitorIcon,
    UsbIcon,
} from 'lucide-react'
import { createRef } from 'react'
import { getFsInfo } from '@/lib/format'
import { formatRemote, parsePath, remoteParentDir } from '@/lib/paths'
import rclone from '@/lib/rclone/client'
import type { AllowedKey, SelectItem } from './types'
import { hostSeparator } from '@/lib/rclone/client'

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/

function isSeparator(ch: string): boolean {
    return ch === '/' || ch === '\\'
}

/// Lexical normalization of a path on the daemon's machine (`.` / `..`, duplicate separators),
/// no filesystem access.
function normalize(path: string): string {
    if (!path) return ''
    const sep = hostSeparator()
    const windows = sep === '\\'
    let prefix = ''
    let rest = path
    if (windows && WINDOWS_DRIVE.test(path)) {
        prefix = path.slice(0, 2) + sep
        rest = path.slice(3)
    } else if (isSeparator(path[0]!)) {
        prefix = sep
        rest = path.slice(1)
    }
    const out: string[] = []
    for (const part of rest.split(/[\\/]+/)) {
        if (!part || part === '.') continue
        if (part === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop()
            else if (!prefix) out.push('..')
            continue
        }
        out.push(part)
    }
    return prefix + out.join(sep)
}

export function join(...parts: string[]): string {
    const filtered = parts.filter((p) => p !== undefined && p !== null && p !== '')
    if (filtered.length === 0) return ''
    return normalize(filtered.join(hostSeparator()))
}

export function dirname(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '')
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    if (index === -1) return '.'
    if (index === 0) return trimmed[0]!
    if (hostSeparator() === '\\' && index === 2 && WINDOWS_DRIVE.test(trimmed)) return trimmed.slice(0, 3)
    return trimmed.slice(0, index)
}

export const dragStateRef = createRef<SelectItem[] | null>() as { current: SelectItem[] | null }
dragStateRef.current = null

export const dropTargetsRef = createRef<
    Map<
        string,
        {
            element: HTMLElement
            onDrop: (items: SelectItem[], destination: string) => void
            getDestination: () => string
        }
    >
>() as {
    current: Map<
        string,
        {
            element: HTMLElement
            onDrop: (items: SelectItem[], destination: string) => void
            getDestination: () => string
        }
    >
}
dropTargetsRef.current = new Map()

export const RE_BACKSLASH = /\\/g
export const RE_TRAILING_SLASH = /\/+$/g
export const RE_LEADING_SLASH = /^\/+/
export const RE_PATH_SEPARATOR = /[/\\]/
export const RE_TRAILING_SEPARATORS = /[\\/]+$/
const RE_RCLONE_GLOB_META = /[\\*?[\]{}]/g

export const VIRTUAL_PADDING_COUNT = 2

export function log(msg: string, ...args: any[]) {
    console.log(`[Navigator] ${msg}`, ...args)
}

export function joinLocal(base: string, name: string) {
    if (!base) return join(hostSeparator(), name)
    return join(base, name)
}

export function getLocalParent(path: string) {
    if (!path) return ''
    return dirname(path)
}

/** The folder above a remote directory; an absolute root (`/`) and the relative one (``) stay put. */
export function getRemoteParent(path: string) {
    return remoteParentDir(path)
}

/** A remote location as one string, spelled as the user did: `remote:dir`, or `remote:/dir`. */
export function serializeRemotePath(remote: string, dir: string) {
    return formatRemote(remote, dir)
}

export function cacheKey(remote: string | 'UI_LOCAL_FS' | null, dir: string) {
    return `${remote ?? 'NONE'}::${dir || '/'}`
}

export function normalizeRemoteDir(path: string) {
    if (!path) return ''
    const cleaned = path.replace(RE_BACKSLASH, '/').replace(RE_TRAILING_SLASH, '')
    return cleaned
}

// Resolves a navigator location to the `fs` + relative dir pair the /operations/* endpoints take:
// the fs is the root — `remote:`, or `remote:/` when the directory was given with a leading
// slash (absolute on sftp), `:local:/` for a local path — and the dir is relative to it.
export function resolveFs(remote: string | 'UI_LOCAL_FS', dir: string) {
    const info = remote === 'UI_LOCAL_FS' ? getFsInfo(dir) : getFsInfo(formatRemote(remote, dir))
    return { fs: info.root, base: info.filePath }
}

// Lists `dir` through /operations/list with the given `opt` (and optional `_filter`) objects. Some
// backends want a trailing slash on the directory and others reject it, so a failed bare call is
// retried slashed. Entries are deduped by path since a few backends report the same object twice.
export async function listPath(
    remote: string | 'UI_LOCAL_FS',
    dir: string,
    opt: Record<string, unknown>,
    signal: AbortSignal,
    filter?: Record<string, unknown>
): Promise<any[]> {
    const { fs, base } = resolveFs(remote, dir)

    const run = async (target: string) => {
        const result = await rclone('/operations/list', {
            params: {
                query: {
                    fs,
                    remote: target,
                    opt: JSON.stringify(opt),
                    ...(filter ? { _filter: JSON.stringify(filter) } : {}),
                } as any,
            },
            signal,
        })
        return Array.isArray(result) ? result : result?.list
    }

    let list: any[] | undefined
    try {
        list = await run(base)
    } catch (error) {
        if (signal.aborted || !base) throw error
        list = await run(`${base}/`)
    }
    if (!Array.isArray(list)) throw new Error('Invalid list response')

    const seen = new Set<string>()
    return (list as any[]).filter((item) => {
        const path = (item?.Path || item?.Name || '') as string
        if (!path || seen.has(path)) return false
        seen.add(path)
        return true
    })
}

export function searchPath(
    remote: string | 'UI_LOCAL_FS',
    dir: string,
    term: string,
    signal: AbortSignal
) {
    const escapedTerm = term.replace(RE_RCLONE_GLOB_META, '\\$&')
    return listPath(remote, dir, { recurse: true, noModTime: false, noMimeType: true }, signal, {
        IncludeRule: [`*${escapedTerm}*`],
        IgnoreCase: true,
    })
}

// Renames a file or folder in place. Folders go through sync/move (the RC API has no directory
// rename). Both endpoints silently overwrite — or merge into — an existing target, so the
// destination is stat'ed first and the rename refused when something is already there.
export async function renamePath(fullPath: string, isDir: boolean, newName: string) {
    const { root: fs, filePath } = getFsInfo(fullPath)
    const dstRemote = [...filePath.split('/').slice(0, -1), newName].join('/')

    const existing = await rclone('/operations/stat', {
        params: { query: { fs, remote: dstRemote } },
    })
    if (existing?.item) throw new Error(`"${newName}" already exists`)

    if (isDir) {
        await rclone('/sync/move' as any, {
            params: {
                query: {
                    srcFs: `${fs}${filePath}/`,
                    dstFs: `${fs}${dstRemote}/`,
                    deleteEmptySrcDirs: true,
                },
            },
        })
    } else {
        await rclone('/operations/movefile' as any, {
            params: { query: { srcFs: fs, srcRemote: filePath, dstFs: fs, dstRemote } },
        })
    }
}

/** A full path as the panel keeps it: the remote and the directory under it, or a local path. */
export function parseRemotePath(fullPath: string): { remote: string | null; path: string } {
    const parsed = parsePath(fullPath)
    if (parsed.kind === 'remote') return { remote: parsed.name, path: parsed.path }
    return { remote: null, path: fullPath }
}

export function getPathSegments(path: string): string[] {
    if (!path) return []
    return path.replace(RE_BACKSLASH, '/').split('/').filter(Boolean)
}

export function buildPathFromSegments(segments: string[], upToIndex: number): string {
    return segments.slice(0, upToIndex + 1).join('/')
}

export function getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.')
    if (lastDot === -1 || lastDot === 0) return ''
    return filename.slice(lastDot + 1).toLowerCase()
}

export function getDiskLabel(disk: string): string {
    const last = disk.split(/[/\\]/).filter(Boolean).pop()
    return last ?? disk
}

const SHORTCUT_FOLDERS = new Set(['desktop', 'documents', 'downloads'])

/**
 * Whether a `/core/disks` entry belongs in the sidebar: filesystem roots and external volumes
 * with `LOCAL_FS`; the home folder and its Desktop/Documents/Downloads only with `LOCAL_FS_EXTRA`.
 */
export function shouldShowDisk(disk: string, allowedKeys: readonly AllowedKey[]): boolean {
    if (disk === '/' || /^[A-Z]:[\\/]?$/i.test(disk)) return true
    // USB / external volumes
    if (/[\\/](?:media|Volumes|mnt)[\\/]/i.test(disk)) return true
    if (!allowedKeys.includes('LOCAL_FS_EXTRA')) return false
    const last = disk.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase()
    if (last && SHORTCUT_FOLDERS.has(last)) return true
    // Home folder: parent is a known users directory
    return /[\\/](?:Users|home)[\\/][^/\\]+\/?$/i.test(disk)
}

export function getDiskIcon(disk: string): { icon: LucideIcon; className: string } {
    const last = disk.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase()
    switch (last) {
        case 'desktop':
            return { icon: MonitorIcon, className: 'text-sky-400' }
        case 'documents':
            return { icon: FileTextIcon, className: 'text-blue-400' }
        case 'downloads':
            return { icon: DownloadIcon, className: 'text-green-400' }
    }
    if (disk === '/' || /^[A-Z]:[\\/]?$/i.test(disk))
        return { icon: HardDriveIcon, className: 'text-zinc-400' }
    if (/[\\/](?:media|Volumes|mnt)[\\/]/i.test(disk))
        return { icon: UsbIcon, className: 'text-orange-400' }
    return { icon: HouseIcon, className: 'text-amber-400' }
}

export function formatModTime(modTime: string | undefined): string {
    if (!modTime) return '—'
    try {
        const date = new Date(modTime)
        return date.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        })
    } catch {
        return modTime
    }
}
