import { t } from '@lingui/core/macro'
import {
    Desktop as DesktopIcon,
    DownloadBracket as DownloadBracketIcon,
    FileText as FileTextIcon,
    Film as FilmIcon,
    HardDrive as HardDriveIcon,
    House as HouseIcon,
    Image as ImageIcon,
    Music as MusicIcon,
    PlugSimple as PlugSimpleIcon,
} from '@zappicon/react'
import { type ComponentType, createRef } from 'react'
import { formatDate } from '../../../lib/format'
import {
    baseName,
    currentHost,
    DRIVE_ROOT,
    formatRemote,
    type Host,
    joinLocalDir,
    joinRemoteDir,
    localParentDir,
    parsePath,
    remoteParentDir,
    separatorOf,
    trailingSeparatorsOf,
} from '../../../lib/paths'
import type { Tone } from '../look/tones'
import type { Favorite } from './favorites'
import { normalizeListingDir } from './listingKey'
import type { AllowedKey, Entry, RemoteString, SelectItem, Sort } from './types'

const TRAILING_SEPARATORS = /[\\/]+$/
const MOUNTED_VOLUME = /[\\/](?:media|Volumes|mnt)[\\/]/i
const HOME_FOLDER = /[\\/](?:Users|home)[\\/][^/\\]+\/?$/i

export const dragStateRef = createRef<SelectItem[] | null>() as { current: SelectItem[] | null }
dragStateRef.current = null

export const VIRTUAL_PADDING_COUNT = 2

export const BY_NAME: Sort = { column: 'name', direction: 'ascending' }

export function expandHome(value: string, home: string, windows = false): string {
    if (!home || !value.startsWith('~')) return value
    const rest = value.slice(1)
    if (rest === '') return home
    if (!(rest[0] === '/' || (windows && rest[0] === '\\'))) return value
    return home.replace(TRAILING_SEPARATORS, '') + rest
}

export function unknownRemote(
    value: string,
    remotes: readonly string[] | undefined,
    host: Host = currentHost()
): string | undefined {
    if (!remotes) return undefined
    const parsed = parsePath(value, host)
    if (parsed.kind !== 'remote' || parsed.name.startsWith(':')) return undefined
    if (remotes.includes(parsed.name)) return undefined
    const name = parsed.name
    return t`There is no remote called ${name}.`
}

export function favoriteRows(favorites: readonly Favorite[]): Entry[] {
    return favorites.map((fav) => {
        const parsed = parsePath(fav.path)
        const remote = parsed.kind === 'remote' ? parsed.name : undefined
        return {
            key: fav.path,
            name: parsed.kind === 'invalid' ? fav.path : favoriteName(remote, baseName(fav.path)),
            isDir: true,
            size: undefined,
            modTime: fav.added > 0 ? new Date(fav.added).toISOString() : undefined,
            remote: remote ?? 'UI_LOCAL_FS',
            fullPath: fav.path,
        } as Entry
    })
}

function favoriteName(remote: string | undefined, folder: string): string {
    if (remote) return `(${remote}) ${folder}`
    return t({
        message: `(LOCAL) ${folder}`,
        comment: 'A favorite folder on this computer. LOCAL stands where a remote would be named.',
    })
}

export function log(msg: string, ...args: any[]) {
    console.log(`[Browser] ${msg}`, ...args)
}

export function joinLocal(base: string, name: string) {
    return joinLocalDir(base, name)
}

export function getLocalParent(path: string) {
    return localParentDir(path)
}

export function getRemoteParent(path: string) {
    return remoteParentDir(path)
}

export function serializeRemotePath(remote: string, dir: string) {
    return formatRemote(remote, dir)
}

export function panelFolder(remote: RemoteString, dir: string): string | null {
    if (!remote || remote === 'UI_FAVORITES') return null
    if (remote === 'UI_LOCAL_FS') return dir || null
    return formatRemote(remote, dir)
}

export function placeOf(
    value: string,
    host: Host = currentHost()
): { remote: string; cwd: string } {
    const parsed = parsePath(value, host)
    if (parsed.kind === 'remote') {
        return { remote: parsed.name + parsed.params, cwd: normalizeListingDir(parsed.path, host) }
    }
    return { remote: 'UI_LOCAL_FS', cwd: value }
}

export function newFolderPath(
    remote: RemoteString,
    cwd: string,
    name: string,
    host: Host = currentHost()
): string | null {
    if (panelFolder(remote, cwd) === null) return null
    if (remote === 'UI_LOCAL_FS') return joinLocalDir(cwd, name, host)
    return formatRemote(remote as string, joinRemoteDir(cwd, name, host))
}

export function parseRemotePath(fullPath: string): { remote: string | null; path: string } {
    const parsed = parsePath(fullPath)
    if (parsed.kind === 'remote') return { remote: parsed.name, path: parsed.path }
    return { remote: null, path: fullPath }
}

export function getPathSegments(path: string): string[] {
    if (!path) return []
    return path.split(separatorOf(currentHost())).filter(Boolean)
}

export function getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.')
    if (lastDot === -1 || lastDot === 0) return ''
    return filename.slice(lastDot + 1).toLowerCase()
}

export function getDiskLabel(disk: string): string {
    const last = disk.split(separatorOf(currentHost())).filter(Boolean).pop()
    return last ?? disk
}

const SHORTCUT_FOLDERS = new Set([
    'desktop',
    'documents',
    'downloads',
    'music',
    'pictures',
    'movies',
    'videos',
])

export function shouldShowDisk(disk: string, allowedKeys: readonly AllowedKey[]): boolean {
    if (disk === '/' || DRIVE_ROOT.test(disk)) return true
    if (MOUNTED_VOLUME.test(disk)) return true
    if (!allowedKeys.includes('LOCAL_FS_EXTRA')) return false
    const last = disk.split(separatorOf(currentHost())).filter(Boolean).pop()?.toLowerCase()
    if (last && SHORTCUT_FOLDERS.has(last)) return true
    return HOME_FOLDER.test(disk)
}

export function getDiskIcon(disk: string): {
    icon: ComponentType<{ className?: string }>
    className: string
    tone: Tone
} {
    const last = disk.split(separatorOf(currentHost())).filter(Boolean).pop()?.toLowerCase()
    switch (last) {
        case 'desktop':
            return { icon: DesktopIcon, className: 'text-sky-400', tone: 'cyan' }
        case 'documents':
            return { icon: FileTextIcon, className: 'text-blue-400', tone: 'indigo' }
        case 'downloads':
            return { icon: DownloadBracketIcon, className: 'text-green-400', tone: 'green' }
        case 'music':
            return { icon: MusicIcon, className: 'text-fuchsia-400', tone: 'fuchsia' }
        case 'pictures':
            return { icon: ImageIcon, className: 'text-lime-400', tone: 'lime' }
        case 'movies':
        case 'videos':
            return { icon: FilmIcon, className: 'text-pink-400', tone: 'pink' }
        default:
            break
    }
    if (disk === '/' || DRIVE_ROOT.test(disk))
        return { icon: HardDriveIcon, className: 'text-zinc-400', tone: 'graphite' }
    if (MOUNTED_VOLUME.test(disk))
        return { icon: PlugSimpleIcon, className: 'text-orange-400', tone: 'orange' }
    return { icon: HouseIcon, className: 'text-amber-400', tone: 'blue' }
}

export function formatModTime(modTime: string | undefined): string {
    const date = modTime ? new Date(modTime) : null
    if (!date || Number.isNaN(date.getTime())) return '—'
    return formatDate(date, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function isInLocalFolder(path: string, folder: string, host: Host = currentHost()): boolean {
    if (!folder || !path.startsWith(folder)) return false
    if (path.length === folder.length || trailingSeparatorsOf(host).test(folder)) return true
    return separatorOf(host).test(path[folder.length])
}
