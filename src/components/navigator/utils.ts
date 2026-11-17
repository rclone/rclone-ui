import { dirname, join, sep } from '@tauri-apps/api/path'
import { readDir } from '@tauri-apps/plugin-fs'
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
import { getFsInfo } from '../../../lib/format.ts'
import rclone from '../../../lib/rclone/client.ts'
import type { SelectItem } from './types'

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

export async function joinLocal(base: string, name: string) {
    if (!base) return join(sep(), name)
    return join(base, name)
}

export async function getLocalParent(path: string) {
    if (!path) return ''
    return dirname(path)
}

export function getRemoteParent(path: string) {
    if (!path) return ''
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return ''
    return parts.slice(0, -1).join('/')
}

export function serializeRemotePath(remote: string, relPath: string) {
    return `${remote}:/${relPath}`
}

export function cacheKey(remote: string | 'UI_LOCAL_FS' | null, dir: string) {
    return `${remote ?? 'NONE'}::${dir || '/'}`
}

export function normalizeRemoteDir(path: string) {
    if (!path) return ''
    const cleaned = path.replace(RE_BACKSLASH, '/').replace(RE_TRAILING_SLASH, '')
    return cleaned
}

export async function listRemotePath(
    remote: string,
    dir: string,
    options: { noModTime?: boolean; noMimeType?: boolean }
) {
    const base = normalizeRemoteDir(dir)
    const slashed = base ? `${base}/` : ''
    log('listRemotePath', { remote, dir, base, slashed, options })

    const tasks: Promise<any>[] = []

    const p1 = {
        fs: `${remote}:`,
        remote: base,
        ...options,
    }
    log('listRemotePath: rclone call 1 params', p1)
    tasks.push(
        rclone('/operations/list', {
            params: {
                query: p1,
            },
        })
    )

    if (slashed) {
        const p2 = {
            fs: `${remote}:`,
            remote: slashed,
            ...options,
        }
        log('listRemotePath: rclone call 2 params', p2)
        tasks.push(
            rclone('/operations/list', {
                params: {
                    query: p2,
                },
            })
        )
    }
    const settled = await Promise.allSettled(tasks)
    log('listRemotePath: settled', settled)

    const merged: any[] = []
    let anyFulfilled = false
    for (let i = 0; i < settled.length; i++) {
        const r = settled[i]
        if (r.status === 'fulfilled') {
            const list = Array.isArray(r.value) ? r.value : r.value?.list

            if (Array.isArray(list)) {
                anyFulfilled = true
                for (let j = 0; j < list.length; j++) {
                    merged.push(list[j])
                }
            }
        }
    }
    if (!anyFulfilled) {
        log('listRemotePath: no successful tasks')
        throw new Error('No access or folder does not exist')
    }
    const seen = new Set<string>()
    const deduped: any[] = []
    for (let i = 0; i < merged.length; i++) {
        const it = merged[i]
        const k = (it && (it.Path || it.Name)) || ''
        if (!k) continue
        if (seen.has(k)) continue
        seen.add(k)
        deduped.push(it)
    }
    log('listRemotePath: result count', deduped.length)
    return { list: deduped, baseDir: base }
}

// Resolves a navigator location to the `fs` + relative dir pair the /operations/* endpoints take:
// local paths go through getFsInfo to the `:local:` backend rooted at `/`, remotes to `remote:`.
function resolveFs(remote: string | 'UI_LOCAL_FS', dir: string) {
    if (remote !== 'UI_LOCAL_FS') return { fs: `${remote}:`, base: normalizeRemoteDir(dir) }
    const info = getFsInfo(dir)
    return { fs: info.root === ':local:' ? ':local:/' : info.root, base: info.filePath }
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
    const { root, filePath } = getFsInfo(fullPath)
    const fs = root === ':local:' ? ':local:/' : root
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

export async function listLocalPath(dir: string) {
    log('listLocalPath', { dir })
    const entries = await readDir(dir)
    log('listLocalPath: entries', entries.length)
    return entries
}

export function parseRemotePath(fullPath: string): { remote: string | null; path: string } {
    if (fullPath.includes(':/')) {
        const [remote, ...rest] = fullPath.split(':/')
        return { remote, path: rest.join('/') }
    }
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

const SHOWN_DISKS = new Set(['desktop', 'documents', 'downloads'])

export function shouldShowDisk(disk: string): boolean {
    if (disk === '/' || /^[A-Z]:[\\/]?$/i.test(disk)) return true
    const last = disk.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase()
    if (last && SHOWN_DISKS.has(last)) return true
    // Home folder: parent is a known users directory
    if (/[\\/](?:Users|home)[\\/][^/\\]+\/?$/i.test(disk)) return true
    // USB / external volumes
    if (/[\\/](?:media|Volumes|mnt)[\\/]/i.test(disk)) return true
    return false
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
