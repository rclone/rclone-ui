import { parse, type Token } from '@messageformat/parser'
import { type Categories, icuCategories } from './plurals.ts'
import { isSetupFormat } from './rclone.ts'
import type { Row } from './types.ts'

/**
 * The checks of a translation. An error is what `go run ./build/i18n -check` fails on, or what
 * breaks the message in the app. A warning is worth a look, but may be right.
 */
export interface Problem {
    level: 'error' | 'warning'
    message: string
}

// The same patterns as build/i18n/main.go, so the site finds what -check finds.
const ICU_ARGUMENT =
    /\{\s*([A-Za-z0-9_]+)\s*(?:\}|,\s*(?:plural|select|selectordinal|number|date|time)\b)/g
const ICU_BRANCH_KEY = /(?:^|[\s{}])(?:zero|one|two|few|many|other|=\d+)\s*$/
const ICU_TAG = /<\/?([A-Za-z0-9_]+)\s*\/?>/g
const PARSER_PLACE = / at line \d+ col \d+:?$/
const LEADING_SPACE = /^\s*/
const TRAILING_SPACE = /\s*$/
const VERB = /%(\[(\d+)\])?[-+# 0]*[0-9.]*([a-zA-Z%])/g

/** The values and tags that an ICU message uses: "{name}", "<0>". */
export function icuPlaceholders(message: string): Set<string> {
    const set = new Set<string>()
    for (const m of message.matchAll(ICU_ARGUMENT)) {
        if (ICU_BRANCH_KEY.test(message.slice(0, m.index))) continue
        set.add(`{${m[1]}}`)
    }
    for (const m of message.matchAll(ICU_TAG)) set.add(`<${m[1]}>`)
    return set
}

/** The values that a Go format uses, as "position:verb", such as "1:s". */
export function verbs(format: string): Set<string> {
    const set = new Set<string>()
    let next = 1
    for (const m of format.matchAll(VERB)) {
        if (m[3] === '%') continue
        const pos = m[2] ? Number(m[2]) : next
        next = pos + 1
        const v = m[3] === 'w' || m[3] === 'v' ? 's' : m[3]
        set.add(`${pos}:${v}`)
    }
    return set
}

function list(items: string[]) {
    return items.map((i) => (i.includes(':') ? `%${i.split(':')[1]}` : i)).join(', ')
}

function compare(want: Set<string>, got: Set<string>, problems: Problem[]) {
    const missing = [...want].filter((p) => !got.has(p))
    const extra = [...got].filter((p) => !want.has(p))
    if (missing.length > 0) {
        problems.push({ level: 'error', message: `Keep ${list(missing)}, as the English has it.` })
    }
    if (extra.length > 0) {
        problems.push({
            level: 'error',
            message: `The English has no ${list(extra)}. Remove it, or check its spelling.`,
        })
    }
}

/** What a form can be called for a translator: "one (1, 21, 31…)". */
export function formLabel(category: string, cats: Categories) {
    const ex = cats.examples.get(category)
    return ex ? `${category} (${ex})` : category
}

function walkCounts(tokens: Token[], visit: (t: Token & { cases: { key: string }[] }) => void) {
    for (const t of tokens) {
        if (t.type === 'plural' || t.type === 'selectordinal') visit(t)
        if (t.type === 'plural' || t.type === 'select' || t.type === 'selectordinal') {
            for (const c of t.cases) walkCounts(c.tokens, visit)
        }
    }
}

function checkIcu(english: string, value: string, tag: string, problems: Problem[]) {
    let tokens: Token[]
    try {
        tokens = parse(value)
    } catch (err) {
        const reason = String((err as Error).message).split('\n')[0]
        problems.push({
            level: 'error',
            message: `The braces don't add up, so the app can't show this text (${reason.replace(PARSER_PLACE, '')}).`,
        })
        return
    }
    compare(icuPlaceholders(english), icuPlaceholders(value), problems)
    const cardinal = icuCategories(tag)
    const ordinal = icuCategories(tag, true)
    walkCounts(tokens, (t) => {
        const cats = t.type === 'selectordinal' ? ordinal : cardinal
        const keys = t.cases.map((c) => c.key)
        if (!keys.includes('other')) {
            problems.push({ level: 'error', message: 'Each count needs an other {…} form.' })
        }
        const unused = keys.filter((k) => !k.startsWith('=') && !cats.all.includes(k))
        if (unused.length > 0) {
            problems.push({
                level: 'warning',
                message: `Your language has no ${unused.join(', ')} form, so the app never shows it. Your forms: ${cats.all.map((c) => formLabel(c, cats)).join(', ')}.`,
            })
        }
        const absent = [...cats.examples.keys()].filter((c) => c !== 'other' && !keys.includes(c))
        if (absent.length > 0) {
            problems.push({
                level: 'warning',
                message: `Add ${absent.map((c) => formLabel(c, cats)).join(' and ')}. Without ${absent.length > 1 ? 'them' : 'it'}, those numbers use the other form.`,
            })
        }
    })
}

function edges(english: string, value: string, problems: Problem[]) {
    const lead = (s: string) => LEADING_SPACE.exec(s)?.[0] ?? ''
    const trail = (s: string) => TRAILING_SPACE.exec(s)?.[0] ?? ''
    if (trail(english).includes('\n') !== trail(value).includes('\n')) {
        problems.push({
            level: 'warning',
            message: english.endsWith('\n')
                ? 'The English ends with a line break. Keep it.'
                : 'The English has no line break at the end.',
        })
    } else if ((trail(english) === '') !== (trail(value) === '')) {
        problems.push({ level: 'warning', message: 'Check the spaces at the end.' })
    }
    if ((lead(english) === '') !== (lead(value) === '')) {
        problems.push({ level: 'warning', message: 'Check the spaces at the start.' })
    }
}

export function checkRow(row: Row, values: string[], tag: string): Problem[] {
    const problems: Problem[] = []
    if (values.every((v) => v === '')) return problems
    if (row.kind === 'app') {
        checkIcu(row.text, values[0] ?? '', tag, problems)
    } else if (row.kind === 'core' && row.plural) {
        if (values.some((v) => v.trim() === '')) {
            problems.push({ level: 'error', message: 'Fill in every form.' })
        }
    } else if (row.kind === 'core' || (row.key && isSetupFormat(row.key))) {
        compare(verbs(row.text), verbs(values[0] ?? ''), problems)
    }
    values.forEach((v, i) => {
        if (v) edges(i > 0 && row.plural ? row.plural : row.text, v, problems)
    })
    return problems
}
