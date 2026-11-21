import { t } from '@lingui/core/macro'
import { compareText, formatNumber } from '../../../lib/format'
import { locale } from '../../../lib/i18n'
import type { HealthResult } from '../../../lib/remotes'
import type { Tone } from '../../components/look/tones'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/**
 * Bytes as a size people read, in steps of 1024: "640 GB", "1.3 TB". The number is written as the
 * app's language writes it ("1,3 TB" in Spanish).
 */
export function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024
        unit++
    }
    const digits = unit === 0 || value >= 100 ? 0 : 1
    const number = formatNumber(value, { maximumFractionDigits: digits, useGrouping: false })
    return `${number} ${UNITS[unit]}`
}

export function spaceFree(size: string): string {
    return t({ message: `${size} free`, comment: 'The space left on storage: "37 GB free".' })
}

/** Names or short items in a row, as the app's language lists them: "a, b, c". */
export function listed(items: string[]): string {
    return new Intl.ListFormat(locale(), { style: 'narrow', type: 'conjunction' }).format(items)
}

/** What a remote stores, as far as its backend reports it. */
export interface Usage {
    used?: number
    free?: number
    total?: number
    /** How full it is, from 0 to 1, when both the use and the size are known. */
    ratio?: number
}

const known = (n: number | null | undefined): n is number =>
    n !== null && n !== undefined && Number.isFinite(n)

/** A remote's usage from its last check, or undefined when the check reported none. */
export function usageOf(health: HealthResult | undefined): Usage | undefined {
    const about = health?.state === 'ok' ? health.about : undefined
    if (!about) return undefined
    const used = known(about.used) ? about.used : undefined
    const total = known(about.total)
        ? about.total
        : used !== undefined && known(about.free)
          ? used + about.free
          : undefined
    const free = known(about.free)
        ? about.free
        : total !== undefined && used !== undefined
          ? Math.max(0, total - used)
          : undefined
    if (used === undefined && free === undefined && total === undefined) return undefined
    const ratio = used !== undefined && total ? Math.min(1, used / total) : undefined
    return { used, free, total, ratio }
}

/** A remote this full is nearly out of space, and its meter turns red. */
export const NEARLY_FULL = 0.9

/**
 * The colors of the parts of the storage bar, given in turn to the remotes that report their use.
 * A remote's meter has the color of its part.
 */
const PALETTE: Tone[] = ['blue', 'violet', 'green', 'orange', 'pink', 'cyan', 'indigo', 'lime']

/** Whether the last check found a problem: no connection, or no answer at all. */
export function needsAttention(health: HealthResult | undefined): boolean {
    return health?.state === 'faulty' || health?.state === 'unknown'
}

export interface Summary {
    connected: number
    failing: number
    noAnswer: number
    checking: number
    /**
     * The storage whose use is known, biggest first, each with its color. Remotes on the same
     * storage (aliases of one disk) share a part: `remotes` names them, and `remote` is the label.
     */
    parts: { remote: string; remotes: string[]; used: number; tone: Tone }[]
    /** The space used and left, counting shared storage once. */
    used: number
    free: number
    /** How many remotes report how much they use. */
    reporting: number
    /** How many connected remotes don't report it. */
    silent: number
    tones: Record<string, Tone>
}

/**
 * The remotes' health and storage, counted together for the top of the window. Remotes that report
 * exactly the same use, space left and size are taken to be on the same storage (aliases of one
 * disk, or a crypt over a remote), which is counted once.
 */
export function summarize(
    remotes: string[],
    health: Record<string, HealthResult | undefined> | undefined
): Summary {
    const summary: Summary = {
        connected: 0,
        failing: 0,
        noAnswer: 0,
        checking: 0,
        parts: [],
        used: 0,
        free: 0,
        reporting: 0,
        silent: 0,
        tones: {},
    }
    const sorted = [...remotes].sort(compareText)
    const byStorage = new Map<string, Summary['parts'][number]>()
    for (const remote of sorted) {
        const h = health?.[remote]
        if (h?.state === 'ok') summary.connected++
        else if (h?.state === 'faulty') summary.failing++
        else if (h?.state === 'unknown') summary.noAnswer++
        else summary.checking++
        const usage = usageOf(h)
        if (usage?.used === undefined) {
            if (h?.state === 'ok') summary.silent++
            continue
        }
        summary.reporting++
        const storage = `${usage.used}:${usage.free ?? ''}:${usage.total ?? ''}`
        const shared = byStorage.get(storage)
        if (shared) {
            shared.remotes.push(remote)
            shared.remote = listed(shared.remotes)
            summary.tones[remote] = shared.tone
            continue
        }
        const tone = PALETTE[summary.parts.length % PALETTE.length]
        summary.tones[remote] = tone
        summary.used += usage.used
        summary.free += usage.free ?? 0
        const part = { remote, remotes: [remote], used: usage.used, tone }
        byStorage.set(storage, part)
        summary.parts.push(part)
    }
    summary.parts.sort((a, b) => b.used - a.used)
    return summary
}
