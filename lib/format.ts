import { plural, t } from '@lingui/core/macro'
import { useEffect, useState } from 'react'
import { locale } from './i18n'
import { baseName, currentHost, type Host, parsePath, readablePath } from './paths'

/**
 * A number as the app's language writes it: "1,234.5" in English, "1.234,5" in Spanish. A value
 * that rclone reads (a size such as 10M, a duration) is never written this way: it keeps
 * rclone's syntax in every language.
 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(locale(), options).format(value)
}

/**
 * A date, a time or both as the app's language writes it, with `Intl.DateTimeFormat`'s options.
 * Without options it is the date and the time in the language's usual short form.
 */
export function formatDate(
    at: number | string | Date,
    options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }
): string {
    return new Intl.DateTimeFormat(locale(), options).format(new Date(at))
}

/**
 * Compares two texts as the app's language sorts them, with numbers inside them in order
 * ("file2" before "file10") and without regard to case or accents.
 */
export function compareText(a: string, b: string): number {
    return sorter().compare(a, b)
}

let sorting: { locale: string; collator: Intl.Collator } | undefined

/** The collator of the window's language, made once. */
function sorter(): Intl.Collator {
    const lang = locale()
    if (sorting?.locale !== lang) {
        const collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' })
        sorting = { locale: lang, collator }
    }
    return sorting.collator
}

/**
 * A text in lower case by the rules of the app's language, for matching what the user types
 * against what the window shows. Names that only the code reads (a key, a file extension) are
 * lower-cased with toLowerCase.
 */
export function foldCase(text: string): string {
    return text.toLocaleLowerCase(locale())
}

/** A size in bytes, in the largest unit that fits: "512 B", "1.5 KB", "20 MB", "3.25 GB". */
export function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes)) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
    }
    // Bytes are whole. The other units show two decimals at most, and no trailing zeros.
    const digits = unit === 0 ? 0 : 2
    const number = formatNumber(value, { maximumFractionDigits: digits, useGrouping: false })
    return `${number} ${units[unit]}`
}

type Unit = 'day' | 'hour' | 'minute' | 'second'

const UNITS: [unit: Unit, ms: number][] = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1000],
]

/** A length of time in one unit: "1 minute", "5 hours". */
function counted(count: number, unit: Unit): string {
    switch (unit) {
        case 'day':
            return plural(count, { one: '# day', other: '# days' })
        case 'hour':
            return plural(count, { one: '# hour', other: '# hours' })
        case 'minute':
            return plural(count, { one: '# minute', other: '# minutes' })
        default:
            return plural(count, { one: '# second', other: '# seconds' })
    }
}

/**
 * How long ago a moment was, or how long until it comes: "less than a minute ago", "5 minutes
 * ago", "in 3 hours". It gives the largest unit, rounded. `precise` gives the two largest units,
 * cut ("1 hour, 5 minutes ago"). An invalid time gives "". Pass `now` from useNow so that the
 * text stays current.
 */
export function timeAgo(at: number | string | Date, now = Date.now(), precise = false): string {
    const time = new Date(at).getTime()
    if (Number.isNaN(time)) return ''
    const delta = now - time
    const length = precise ? twoUnits(Math.abs(delta)) : oneUnit(Math.abs(delta))
    if (length === null) {
        if (precise) return t`just now`
        return delta >= 0 ? t`less than a minute ago` : t`in less than a minute`
    }
    return delta >= 0
        ? t({ message: `${length} ago`, comment: 'How long ago: "5 minutes ago".' })
        : t({ message: `in ${length}`, comment: 'How long until: "in 5 minutes".' })
}

/** The largest unit, rounded, from minutes up (59.7 minutes is 1 hour). Null under 30 s. */
function oneUnit(ms: number): string | null {
    const minutes = Math.round(ms / 60_000)
    if (minutes < 1) return null
    if (minutes < 60) return counted(minutes, 'minute')
    const hours = Math.round(ms / 3_600_000)
    if (hours < 24) return counted(hours, 'hour')
    return counted(Math.round(ms / 86_400_000), 'day')
}

/** The two largest units, cut. Null under a second. */
function twoUnits(ms: number): string | null {
    let left = ms
    const parts: string[] = []
    for (const [unit, size] of UNITS) {
        if (parts.length === 2) break
        const count = Math.floor(left / size)
        if (count === 0) {
            if (parts.length > 0) break
            continue
        }
        left -= count * size
        parts.push(counted(count, unit))
    }
    if (parts.length === 0) return null
    if (parts.length === 1) return parts[0]
    const [larger, smaller] = parts
    return t({
        message: `${larger}, ${smaller}`,
        comment: 'Two lengths of time together: "1 hour, 5 minutes".',
    })
}

/**
 * The current time, which changes every `intervalMs` (30 s by default), so that a component that
 * shows timeAgo re-renders and its text stays current. null stops the updates.
 */
export function useNow(intervalMs: number | null = 30_000): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (intervalMs === null) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(id)
    }, [intervalMs])
    return now
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
 * Returns the remote that a path names, or null for a local path or one that rclone would refuse.
 * Paths are parsed by `lib/paths.ts`, which follows rclone's own rules. `:local` is the local
 * backend written as a remote, a drive letter on a Windows host is local, and a colon inside a
 * file name doesn't make the path a remote.
 */
export function getRemoteName(path?: string, host: Host = currentHost()) {
    if (!path) return null
    const parsed = parsePath(path, host)
    return parsed.kind === 'remote' ? parsed.name : null
}

/**
 * Shows a path as it was typed. `short` returns its last segment. `long` returns the whole path,
 * shortened in the middle to `<first>/.../<parent>/<name>` (see `readablePath` in `lib/paths.ts`).
 * Nothing is added: the slash after a remote's colon is kept or left out as the user typed it.
 */
export function buildReadablePath(path: string, type: 'short' | 'long' = 'long') {
    if (!path) {
        return ''
    }

    // The last name, as rclone reads the path on this host. A root is shown as itself.
    if (type === 'short') {
        return baseName(path) || path
    }

    return readablePath(path)
}
