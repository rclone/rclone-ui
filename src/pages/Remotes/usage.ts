import { t } from '@lingui/core/macro'
import { compareText, formatNumber } from '../../../lib/format'
import { locale } from '../../../lib/i18n'
import type { HealthResult } from '../../../lib/remotes'
import type { Tone } from '../../components/look/tones'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

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

export function listed(items: string[]): string {
    return new Intl.ListFormat(locale(), { style: 'narrow', type: 'conjunction' }).format(items)
}

export interface Usage {
    used?: number
    free?: number
    total?: number
    ratio?: number
}

const known = (n: number | null | undefined): n is number =>
    n !== null && n !== undefined && Number.isFinite(n)

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

export const NEARLY_FULL = 0.9

const PALETTE: Tone[] = ['blue', 'violet', 'green', 'orange', 'pink', 'cyan', 'indigo', 'lime']

export function needsAttention(health: HealthResult | undefined): boolean {
    return health?.state === 'faulty' || health?.state === 'unknown'
}

export interface Summary {
    connected: number
    failing: number
    noAnswer: number
    checking: number
    parts: { remote: string; remotes: string[]; used: number; tone: Tone }[]
    used: number
    free: number
    reporting: number
    silent: number
    tones: Record<string, Tone>
}

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
