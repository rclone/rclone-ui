import { plural, t } from '@lingui/core/macro'
import type { Browse } from '../../../lib/core/types'
import { formatNumber } from '../../../lib/format'

export type UsageSort = `${Browse.UsageSort}`

export interface UsageItem {
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
    rest?: true
}

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

export function barLength(bytes: number, largest: number): number {
    if (largest <= 0 || bytes <= 0) return 0
    return Math.min(1, bytes / largest)
}

export function shareOf(bytes: number, total: number): number {
    if (total <= 0 || bytes <= 0) return 0
    return Math.min(1, bytes / total)
}

export function formatShare(share: number): string {
    if (share > 0 && share < 0.01) {
        const one = formatNumber(0.01, { style: 'percent' })
        return t({ message: `<${one}`, comment: 'A share of a folder smaller than 1%: "<1%".' })
    }
    return formatNumber(share, { style: 'percent', maximumFractionDigits: 0 })
}

export function rowsToAsk(scrollTop: number, viewHeight: number, rowHeight: number): number {
    const below = Math.ceil((scrollTop + viewHeight) / rowHeight)
    return Math.max(200, Math.ceil((below + 100) / 100) * 100)
}

export function crumbsOf(rel: string): { name: string; rel: string }[] {
    if (!rel) return []
    const names = rel.split('/')
    return names.map((name, i) => ({ name, rel: names.slice(0, i + 1).join('/') }))
}

export function parentRel(rel: string): string {
    const at = rel.lastIndexOf('/')
    return at < 0 ? '' : rel.slice(0, at)
}

export function restName(files: number): string {
    return plural(files, { one: '# smaller file', other: '# smaller files' })
}

export function filesText(files: number): string {
    return plural(files, { one: '# file', other: '# files' })
}

export function foldersText(folders: number): string {
    return plural(folders, { one: '# folder', other: '# folders' })
}

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
