// Disk Usage (`DiskUsageDrawer`): what the drawer shows of a scan, worked out from the core's
// rows (browse.UsageLevel). The core scans a whole remote or disk and keeps the totals. The page
// reads one folder at a time, and again every `USAGE_BEAT` ms while the scan runs
// (`useUsageLevel`). Each row glides to the place of its new rank.

import { plural, t } from '@lingui/core/macro'
import type { Browse } from '../../../lib/core/types'
import { formatNumber } from '../../../lib/format'

/** How a folder's rows are sorted: largest first, A to Z, or most files first. */
export type UsageSort = `${Browse.UsageSort}`

/** One line of the list: an entry of the folder, or its smaller files together. */
export interface UsageItem {
    /**
     * Stays the same while the entry's size changes, so its row glides to its new place. It
     * tells a file from a folder of the same name, which a bucket can hold.
     */
    key: string
    name: string
    rel: string
    path: string
    isDir: boolean
    bytes: number
    files: number
    folders: number
    unknown: number
    unread: boolean
    unreadBelow: number
    /** The files that the core counts but doesn't keep by name. */
    rest?: true
}

/** The key of the smaller files' line, which no entry's name can have. */
export const REST_KEY = '\u0000rest'

function itemOf(row: Browse.UsageRow): UsageItem {
    return {
        key: `${row.isDir ? 'd' : 'f'}:${row.name}`,
        name: row.name,
        rel: row.rel,
        path: row.path,
        isDir: row.isDir,
        bytes: row.bytes,
        files: row.files,
        folders: row.folders,
        unknown: row.unknown,
        unread: row.unread ?? false,
        unreadBelow: row.unreadBelow ?? 0,
    }
}

/**
 * The folder's lines in order. The smaller files are one line, placed by its size or its count
 * like any other, and last when sorted by name.
 */
export function usageItems(level: Browse.UsageLevel, by: UsageSort): UsageItem[] {
    const items = (level.rows ?? []).map(itemOf)
    const rest = level.rest
    if (!rest || rest.files === 0) return items
    const line: UsageItem = {
        key: REST_KEY,
        name: '',
        rel: '',
        path: '',
        isDir: false,
        bytes: rest.bytes,
        files: rest.files,
        folders: 0,
        unknown: rest.unknown,
        unread: false,
        unreadBelow: 0,
        rest: true,
    }
    if (by === 'name') return [...items, line]
    const after =
        by === 'files'
            ? (item: UsageItem) =>
                  item.files < line.files || (item.files === line.files && item.bytes < line.bytes)
            : (item: UsageItem) =>
                  item.bytes < line.bytes || (item.bytes === line.bytes && item.files < line.files)
    const at = items.findIndex(after)
    return at < 0 ? [...items, line] : [...items.slice(0, at), line, ...items.slice(at)]
}

/** The length of an entry's bar, from 0 to 1, against the largest entry in its folder. */
export function barLength(bytes: number, largest: number): number {
    if (largest <= 0 || bytes <= 0) return 0
    return Math.min(1, bytes / largest)
}

/** The entry's share of its folder, from 0 to 1. */
export function shareOf(bytes: number, total: number): number {
    if (total <= 0 || bytes <= 0) return 0
    return Math.min(1, bytes / total)
}

/** A share as the app's language writes it: "42%", and "<1%" for a sliver that isn't nothing. */
export function formatShare(share: number): string {
    if (share > 0 && share < 0.01) {
        const one = formatNumber(0.01, { style: 'percent' })
        return t({ message: `<${one}`, comment: 'A share of a folder smaller than 1%: "<1%".' })
    }
    return formatNumber(share, { style: 'percent', maximumFractionDigits: 0 })
}

/**
 * The number of rows to ask the core for: those down to the bottom of the view, with a margin, in
 * steps of 100, so that scrolling a little doesn't ask again.
 */
export function rowsToAsk(scrollTop: number, viewHeight: number, rowHeight: number): number {
    const below = Math.ceil((scrollTop + viewHeight) / rowHeight)
    return Math.max(200, Math.ceil((below + 100) / 100) * 100)
}

/** The breadcrumb of a folder below the scan's root: each folder above it, then itself. */
export function crumbsOf(rel: string): { name: string; rel: string }[] {
    if (!rel) return []
    const names = rel.split('/')
    return names.map((name, i) => ({ name, rel: names.slice(0, i + 1).join('/') }))
}

/** The folder above rel, "" for a folder at the root. */
export function parentRel(rel: string): string {
    const at = rel.lastIndexOf('/')
    return at < 0 ? '' : rel.slice(0, at)
}

/** "4,210 smaller files": the line for the files that the scan doesn't keep by name. */
export function restName(files: number): string {
    return plural(files, { one: '# smaller file', other: '# smaller files' })
}

export function filesText(files: number): string {
    return plural(files, { one: '# file', other: '# files' })
}

export function foldersText(folders: number): string {
    return plural(folders, { one: '# folder', other: '# folders' })
}

/**
 * The ranks of the rows to draw: those that are in view now, and those that were in view a
 * moment ago and move out of it, so they glide away rather than vanish.
 */
export function rowsToDraw(
    items: readonly UsageItem[],
    was: ReadonlyMap<string, number>,
    first: number,
    last: number
): { item: UsageItem; rank: number }[] {
    const out: { item: UsageItem; rank: number }[] = []
    for (let rank = 0; rank < items.length; rank++) {
        const item = items[rank]
        const before = was.get(item.key)
        const inView = rank >= first && rank <= last
        const wasInView = before !== undefined && before >= first && before <= last
        if (inView || wasInView) out.push({ item, rank })
    }
    return out
}
