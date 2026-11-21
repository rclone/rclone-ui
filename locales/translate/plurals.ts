import { parse, type Select, type Token } from '@messageformat/parser'

/**
 * Counts have two systems in the app:
 * - app.po's messages are ICU messages. Lingui picks a form by the language's CLDR categories
 *   (one, few, many, other…), which the browser knows for every language (Intl.PluralRules).
 * - core.po's messages are gettext's. A form is picked by the Plural-Forms rule in the file's
 *   header, which isn't in the browser, so the common languages' rules are listed here.
 */

const ONE_FORM = 'nplurals=1; plural=0;'
const NOT_ONE = 'nplurals=2; plural=(n != 1);'
const ABOVE_ONE = 'nplurals=2; plural=(n > 1);'
const SLAVIC =
    'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);'

/** The Plural-Forms rules of common languages, by the start of their tag. */
export const GETTEXT_RULES: Record<string, string> = {
    af: NOT_ONE,
    am: ABOVE_ONE,
    ar: 'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);',
    az: NOT_ONE,
    be: SLAVIC,
    bg: NOT_ONE,
    bn: NOT_ONE,
    bs: SLAVIC,
    ca: NOT_ONE,
    cs: 'nplurals=3; plural=(n==1 ? 0 : n>=2 && n<=4 ? 1 : 2);',
    da: NOT_ONE,
    de: NOT_ONE,
    el: NOT_ONE,
    eo: NOT_ONE,
    es: NOT_ONE,
    et: NOT_ONE,
    eu: NOT_ONE,
    fa: ABOVE_ONE,
    fi: NOT_ONE,
    fil: ABOVE_ONE,
    fr: ABOVE_ONE,
    ga: 'nplurals=5; plural=(n==1 ? 0 : n==2 ? 1 : n<7 ? 2 : n<11 ? 3 : 4);',
    gl: NOT_ONE,
    gu: NOT_ONE,
    he: NOT_ONE,
    hi: NOT_ONE,
    hr: SLAVIC,
    hu: NOT_ONE,
    hy: ABOVE_ONE,
    id: ONE_FORM,
    is: 'nplurals=2; plural=(n%10!=1 || n%100==11);',
    it: NOT_ONE,
    ja: ONE_FORM,
    ka: NOT_ONE,
    kk: NOT_ONE,
    km: ONE_FORM,
    kn: NOT_ONE,
    ko: ONE_FORM,
    ky: NOT_ONE,
    lo: ONE_FORM,
    lt: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && (n%100<10 || n%100>=20) ? 1 : 2);',
    lv: 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n != 0 ? 1 : 2);',
    mk: 'nplurals=2; plural=(n%10==1 && n%100!=11 ? 0 : 1);',
    ml: NOT_ONE,
    mn: NOT_ONE,
    mr: NOT_ONE,
    ms: ONE_FORM,
    my: ONE_FORM,
    nb: NOT_ONE,
    ne: NOT_ONE,
    nl: NOT_ONE,
    nn: NOT_ONE,
    pl: 'nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
    pt: ABOVE_ONE,
    'pt-PT': NOT_ONE,
    ro: 'nplurals=3; plural=(n==1 ? 0 : (n==0 || (n%100 > 0 && n%100 < 20)) ? 1 : 2);',
    ru: SLAVIC,
    sk: 'nplurals=3; plural=(n==1 ? 0 : n>=2 && n<=4 ? 1 : 2);',
    sl: 'nplurals=4; plural=(n%100==1 ? 0 : n%100==2 ? 1 : n%100==3 || n%100==4 ? 2 : 3);',
    sq: NOT_ONE,
    sr: SLAVIC,
    sv: NOT_ONE,
    sw: NOT_ONE,
    ta: NOT_ONE,
    te: NOT_ONE,
    th: ONE_FORM,
    tr: NOT_ONE,
    uk: SLAVIC,
    ur: NOT_ONE,
    uz: NOT_ONE,
    vi: ONE_FORM,
    zh: ONE_FORM,
}

export function gettextRule(tag: string): string {
    const parts = tag.split('-')
    for (let n = parts.length; n > 0; n--) {
        const rule = GETTEXT_RULES[parts.slice(0, n).join('-')]
        if (rule) return rule
    }
    return NOT_ONE
}

const NPLURALS = /nplurals\s*=\s*(\d+)/
const PLURAL = /plural\s*=\s*([^;]+)/
const QUOTED = /['{}#|]/

export function formCount(pluralForms: string) {
    const n = Number(NPLURALS.exec(pluralForms)?.[1])
    return n > 0 && n < 10 ? n : 2
}

/**
 * Evaluates the expression of a Plural-Forms rule for n. It reads the C operators that the rules
 * use, and nothing else, so a rule from a file can't run code.
 */
export function evaluateRule(pluralForms: string, n: number): number {
    const expr = PLURAL.exec(pluralForms)?.[1] ?? '0'
    const tokens = expr.match(/\d+|n|&&|\|\||==|!=|<=|>=|[-+*/%<>!?:()]/g) ?? []
    let i = 0
    const peek = () => tokens[i]
    const next = () => tokens[i++]

    const primary = (): number => {
        const t = next()
        if (t === '(') {
            const v = ternary()
            next()
            return v
        }
        if (t === '!') return Number(!primary())
        if (t === '-') return -primary()
        if (t === 'n') return n
        return Number(t) || 0
    }
    const binary = (ops: string[], operand: () => number) => (): number => {
        let v = operand()
        while (ops.includes(peek())) {
            const op = next()
            const r = operand()
            if (op === '*') v *= r
            else if (op === '/') v = r ? Math.trunc(v / r) : 0
            else if (op === '%') v = r ? v % r : 0
            else if (op === '+') v += r
            else if (op === '-') v -= r
            else if (op === '<') v = Number(v < r)
            else if (op === '>') v = Number(v > r)
            else if (op === '<=') v = Number(v <= r)
            else if (op === '>=') v = Number(v >= r)
            else if (op === '==') v = Number(v === r)
            else if (op === '!=') v = Number(v !== r)
            else if (op === '&&') v = Number(Boolean(v) && Boolean(r))
            else if (op === '||') v = Number(Boolean(v) || Boolean(r))
        }
        return v
    }
    const product = binary(['*', '/', '%'], primary)
    const sum = binary(['+', '-'], product)
    const compare = binary(['<', '>', '<=', '>='], sum)
    const equal = binary(['==', '!='], compare)
    const and = binary(['&&'], equal)
    const or = binary(['||'], and)
    function ternary(): number {
        const cond = or()
        if (peek() !== '?') return cond
        next()
        const yes = ternary()
        next()
        const no = ternary()
        return cond ? yes : no
    }
    return ternary()
}

/** Some numbers that pick a value of each list, such as "2, 3, 4, 22…". */
function examples(pick: (n: number) => string, keys: string[]) {
    const found = new Map<string, number[]>(keys.map((k) => [k, []]))
    for (let n = 0; n <= 1000; n++) found.get(pick(n))?.push(n)
    return new Map(
        [...found].map(([k, ns]) => {
            const shown = ns.slice(0, 4).join(', ')
            return [k, ns.length > 4 ? `${shown}…` : shown]
        })
    )
}

/** The numbers that pick each form of a Plural-Forms rule. */
export function gettextExamples(pluralForms: string): string[] {
    const n = formCount(pluralForms)
    const keys = Array.from({ length: n }, (_, i) => String(i))
    const found = examples((x) => String(evaluateRule(pluralForms, x)), keys)
    return keys.map((k) => found.get(k) ?? '')
}

const CLDR_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other']

export interface Categories {
    /** The categories that the language has, in CLDR's order. */
    all: string[]
    /** Some whole numbers for each category. A category that no count up to 1,000 picks has none. */
    examples: Map<string, string>
}

const known = new Map<string, Categories>()

export function icuCategories(tag: string, ordinal = false): Categories {
    const id = `${tag}:${ordinal}`
    let cats = known.get(id)
    if (!cats) {
        cats = readCategories(tag, ordinal)
        known.set(id, cats)
    }
    return cats
}

function readCategories(tag: string, ordinal: boolean): Categories {
    let rules: Intl.PluralRules
    try {
        rules = new Intl.PluralRules(tag, { type: ordinal ? 'ordinal' : 'cardinal' })
    } catch {
        rules = new Intl.PluralRules('en', { type: ordinal ? 'ordinal' : 'cardinal' })
    }
    const all = CLDR_ORDER.filter((c) =>
        (rules.resolvedOptions().pluralCategories as string[]).includes(c)
    )
    const found = examples((n) => rules.select(n), all)
    return { all, examples: new Map([...found].filter(([, v]) => v !== '')) }
}

/** The index of the brace that closes the one at open, past ICU's quoted text ('{'). */
function closingBrace(src: string, open: number) {
    let depth = 0
    for (let i = open; i < src.length; i++) {
        const c = src[i]
        if (c === "'" && QUOTED.test(src[i + 1] ?? '')) {
            if (src[i + 1] === "'") {
                i++
                continue
            }
            const end = src.indexOf("'", i + 1)
            if (end === -1) return -1
            i = end
            continue
        }
        if (c === '{') depth++
        else if (c === '}' && --depth === 0) return i
    }
    return -1
}

/**
 * The English message with the forms of each count that the language has, so a translator starts
 * from the right forms. A form that English lacks starts as English's `other`. Exact forms (=0)
 * stay. A message that can't be read is returned as it is.
 */
export function withForms(message: string, tag: string): string {
    let tokens: Token[]
    try {
        tokens = parse(message)
    } catch {
        return message
    }
    const selects = tokens.filter(
        (t): t is Select => t.type === 'plural' || t.type === 'selectordinal'
    )
    let out = message
    for (const s of selects.reverse()) {
        const start = s.ctx.offset
        const end = closingBrace(message, start)
        if (end === -1) return message
        const bodies = new Map<string, string>()
        for (const c of s.cases) {
            const open = c.ctx.offset + c.ctx.text.length - 1
            const close = closingBrace(message, open)
            if (close === -1) return message
            bodies.set(c.key, withForms(message.slice(open + 1, close), tag))
        }
        const other = bodies.get('other') ?? ''
        const exact = s.cases.filter((c) => c.key.startsWith('=')).map((c) => c.key)
        const wanted = icuCategories(tag, s.type === 'selectordinal').all
        const cases = [...exact, ...wanted].map((k) => `${k} {${bodies.get(k) ?? other}}`)
        out = `${out.slice(0, start)}${s.ctx.text}${cases.join(' ')}}${out.slice(end + 1)}`
    }
    return out
}
