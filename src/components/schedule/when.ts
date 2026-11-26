import { selectOrdinal, t } from '@lingui/core/macro'
import { formatDate, timeAgo } from '../../../lib/format'

export type WhenKind = 'hour' | 'day' | 'weekday' | 'week' | 'month' | 'custom'

export interface WhenForm {
    kind: WhenKind
    minute: number
    hour: number
    weekday: number
    monthDay: number
    expression: string
}

export const WHEN_CHOICES: { kind: WhenKind; label: string }[] = [
    { kind: 'hour', label: t`Every hour` },
    { kind: 'day', label: t`Every day` },
    { kind: 'weekday', label: t({ message: 'Every weekday', comment: 'Monday to Friday.' }) },
    { kind: 'week', label: t`Every week` },
    { kind: 'month', label: t`Every month` },
    {
        kind: 'custom',
        label: t({
            message: 'Custom',
            comment: 'A choice of when a schedule runs: a cron expression that the user writes.',
        }),
    },
]

function weekdayName(day: number): string {
    return formatDate(new Date(2024, 0, 7 + day), { weekday: 'long' })
}

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ day, name: weekdayName(day) }))

export const CUSTOM_PLACEHOLDER = '0 2 * * *'

export const DEFAULT_WHEN: WhenForm = {
    kind: 'day',
    minute: 0,
    hour: 2,
    weekday: 1,
    monthDay: 1,
    expression: '',
}

const pad = (n: number) => String(n).padStart(2, '0')

const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }

export function clock(hour: number, minute: number): string {
    return formatDate(new Date(2024, 0, 1, hour, minute), CLOCK)
}

export function toCron(form: WhenForm): string {
    const { minute: m, hour: h } = form
    switch (form.kind) {
        case 'hour':
            return `${m} * * * *`
        case 'day':
            return `${m} ${h} * * *`
        case 'weekday':
            return `${m} ${h} * * 1-5`
        case 'week':
            return `${m} ${h} * * ${form.weekday}`
        case 'month':
            return `${m} ${h} ${form.monthDay} * *`
        default:
            return form.expression.trim()
    }
}

const PLAIN_NUMBER = /^\d{1,2}$/
const SPACES = /\s+/

function number(field: string, min: number, max: number): number | null {
    if (!PLAIN_NUMBER.test(field)) return null
    const n = Number(field)
    return n >= min && n <= max ? n : null
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function dayOfWeek(field: string): number | null {
    const name = DAY_NAMES.indexOf(field.toLowerCase())
    if (name >= 0) return name
    const n = number(field, 0, 7)
    return n === null ? null : n % 7
}

const ALIASES: Record<string, Partial<WhenForm>> = {
    '@hourly': { kind: 'hour', minute: 0 },
    '@daily': { kind: 'day', minute: 0, hour: 0 },
    '@weekly': { kind: 'week', minute: 0, hour: 0, weekday: 0 },
    '@monthly': { kind: 'month', minute: 0, hour: 0, monthDay: 1 },
}

export function fromCron(expression: string): WhenForm {
    const text = expression.trim()
    const custom: WhenForm = { ...DEFAULT_WHEN, kind: 'custom', expression: text }
    const alias = ALIASES[text.toLowerCase()]
    if (alias) return { ...DEFAULT_WHEN, ...alias, expression: text }

    const fields = text.split(SPACES)
    if (fields.length !== 5) return custom
    const [min, hr, dom, month, dow] = fields
    const minute = number(min, 0, 59)
    if (minute === null || month !== '*') return custom
    const base = { ...DEFAULT_WHEN, minute, expression: text }
    if (hr === '*' && dom === '*' && dow === '*') return { ...base, kind: 'hour' }
    const hour = number(hr, 0, 23)
    if (hour === null) return custom
    if (dom === '*') {
        if (dow === '*') return { ...base, hour, kind: 'day' }
        if (dow === '1-5' || dow.toLowerCase() === 'mon-fri')
            return { ...base, hour, kind: 'weekday' }
        const weekday = dayOfWeek(dow)
        if (weekday !== null) return { ...base, hour, weekday, kind: 'week' }
        return custom
    }
    const monthDay = number(dom, 1, 28)
    if (monthDay !== null && dow === '*') return { ...base, hour, monthDay, kind: 'month' }
    return custom
}

export function whenInWords(expression: string): string | null {
    const form = fromCron(expression)
    const time = clock(form.hour, form.minute)
    switch (form.kind) {
        case 'hour': {
            const minute = pad(form.minute)
            return t({
                message: `Every hour at :${minute}`,
                comment:
                    '{minute} is the minute past each hour, as two digits: "Every hour at :05".',
            })
        }
        case 'day':
            return t`Every day at ${time}`
        case 'weekday':
            return t({ message: `Every weekday at ${time}`, comment: 'Monday to Friday.' })
        case 'week': {
            const day = weekdayName(form.weekday)
            return t({
                message: `Every ${day} at ${time}`,
                comment: '{day} is the name of a day of the week: "Every Friday at 18:00".',
            })
        }
        case 'month': {
            const day = form.monthDay
            return t({
                message: selectOrdinal(day, {
                    one: `Every month on the #st at ${time}`,
                    two: `Every month on the #nd at ${time}`,
                    few: `Every month on the #rd at ${time}`,
                    other: `Every month on the #th at ${time}`,
                }),
                comment: 'The day of the month, as an ordinal: "Every month on the 1st at 03:00".',
            })
        }
        default:
            return null
    }
}

export function runsSentence(name: string, expression: string): string {
    const form = fromCron(expression)
    const time = clock(form.hour, form.minute)
    switch (form.kind) {
        case 'hour': {
            const minute = pad(form.minute)
            return t({
                message: `${name} runs every hour at :${minute}.`,
                comment:
                    '{minute} is the minute past each hour, as two digits: "Every hour at :05".',
            })
        }
        case 'day':
            return t`${name} runs every day at ${time}.`
        case 'weekday':
            return t({
                message: `${name} runs every weekday at ${time}.`,
                comment: 'Monday to Friday.',
            })
        case 'week': {
            const day = weekdayName(form.weekday)
            return t({
                message: `${name} runs every ${day} at ${time}.`,
                comment:
                    '{day} is the name of a day of the week: "Photos runs every Friday at 18:00."',
            })
        }
        case 'month': {
            const day = form.monthDay
            return t({
                message: selectOrdinal(day, {
                    one: `${name} runs every month on the #st at ${time}.`,
                    two: `${name} runs every month on the #nd at ${time}.`,
                    few: `${name} runs every month on the #rd at ${time}.`,
                    other: `${name} runs every month on the #th at ${time}.`,
                }),
                comment:
                    'The day of the month, as an ordinal: "Photos runs every month on the 1st at 03:00."',
            })
        }
        default: {
            const cron = expression.trim()
            return t`${name} runs on the cron schedule ${cron}.`
        }
    }
}

export function shortTime(ms: number): string {
    return formatDate(ms, { weekday: 'short', day: 'numeric', month: 'short', ...CLOCK })
}

export function nextRunsLine(next: readonly number[], zone: string): string {
    const times = next.map(shortTime).join(' · ')
    return zone ? t`Next runs: ${times} (${zone})` : t`Next runs: ${times}`
}

const DAY = 86_400_000

export function nextRunText(nextRun: number | null, now: number): string {
    if (nextRun === null) return ''
    if (nextRun <= now) return t`Next run soon`
    if (nextRun - now < DAY) {
        const relative = timeAgo(nextRun, now)
        return t({
            message: `Next run ${relative}`,
            comment: '{relative} is how long until the run: "Next run in 3 hours".',
        })
    }
    const date = shortTime(nextRun)
    return t({
        message: `Next run ${date}`,
        comment: '{date} is the day and the time of the run: "Next run Mon, Nov 9, 02:00".',
    })
}
