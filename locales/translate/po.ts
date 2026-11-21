/**
 * Reads and writes the PO files in locales/. Each file is written the way its own tool writes it,
 * so a translation from the site changes only the translated lines:
 * - app.po as Lingui writes it (pofile-ts, without folding long lines);
 * - core.po as build/i18n writes it (build/i18n/po.go).
 */

export interface PoEntry {
    /** Translator comments: `# `. */
    comments: string[]
    /** Notes from the code: `#. `. */
    notes: string[]
    /** Files: `#: `. */
    refs: string[]
    flags: string[]
    ctx?: string
    id: string
    plural?: string
    strs: string[]
}

export interface PoFile {
    /** The header's lines without their line breaks, such as "Language: es". */
    header: string[]
    entries: PoEntry[]
}

const UNESCAPE: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    a: '\x07',
    b: '\b',
    v: '\v',
    f: '\f',
}

function unquote(s: string): string {
    const body = s.trim().slice(1, -1)
    return body.replace(/\\(.)/g, (_, c: string) => UNESCAPE[c] ?? c)
}

function emptyEntry(): PoEntry {
    return { comments: [], notes: [], refs: [], flags: [], id: '', strs: [] }
}

const LINE_BREAK = /\r?\n/
const NUMBERED_MSGSTR = /^msgstr\[(\d+)\]\s*(".*")$/

export function parsePo(text: string): PoFile {
    const file: PoFile = { header: [], entries: [] }
    let entry: PoEntry | null = null
    let field: 'ctx' | 'id' | 'plural' | number | null = null
    let headerRead = false

    const flush = () => {
        if (!entry) return
        if (!headerRead && entry.id === '' && entry.ctx === undefined) {
            file.header = (entry.strs[0] ?? '').split('\n').filter((line) => line !== '')
        } else if (entry.id !== '' || entry.ctx !== undefined) {
            file.entries.push(entry)
        }
        headerRead = true
        entry = null
        field = null
    }

    for (const raw of text.split(LINE_BREAK)) {
        const line = raw.trim()
        if (line === '') {
            flush()
            continue
        }
        if (line.startsWith('#~')) continue
        // An entry that isn't followed by a blank line ends where the next one starts.
        const starts = line.startsWith('#') || line.startsWith('msgctxt ')
        const startsId = line.startsWith('msgid ') && field !== 'ctx'
        if (entry && (starts || startsId) && entry.strs.length > 0) flush()
        entry ??= emptyEntry()

        if (line.startsWith('#.')) entry.notes.push(line.slice(2).trim())
        else if (line.startsWith('#:')) entry.refs.push(line.slice(2).trim())
        else if (line.startsWith('#,')) entry.flags.push(line.slice(2).trim())
        else if (line.startsWith('#')) entry.comments.push(line.slice(1).trim())
        else if (line.startsWith('msgctxt ')) {
            field = 'ctx'
            entry.ctx = unquote(line.slice(8))
        } else if (line.startsWith('msgid_plural ')) {
            field = 'plural'
            entry.plural = unquote(line.slice(13))
        } else if (line.startsWith('msgid ')) {
            field = 'id'
            entry.id = unquote(line.slice(6))
        } else if (line.startsWith('msgstr[')) {
            const m = NUMBERED_MSGSTR.exec(line)
            if (!m) continue
            field = Number(m[1])
            entry.strs[field] = unquote(m[2])
        } else if (line.startsWith('msgstr ')) {
            field = 0
            entry.strs[0] = unquote(line.slice(7))
        } else if (line.startsWith('"') && entry && field !== null) {
            const more = unquote(line)
            if (field === 'ctx') entry.ctx += more
            else if (field === 'id') entry.id += more
            else if (field === 'plural') entry.plural += more
            else entry.strs[field] += more
        }
    }
    flush()
    for (const e of file.entries) {
        for (let i = 0; i < e.strs.length; i++) e.strs[i] ??= ''
    }
    return file
}

export function headerValue(header: string[], name: string): string {
    const prefix = `${name.toLowerCase()}:`
    const line = header.find((h) => h.toLowerCase().startsWith(prefix))
    return line ? line.slice(prefix.length).trim() : ''
}

/** Sets a header line, or adds it at the end. */
export function withHeader(header: string[], name: string, value: string): string[] {
    const prefix = `${name.toLowerCase()}:`
    const line = `${name}: ${value}`
    const i = header.findIndex((h) => h.toLowerCase().startsWith(prefix))
    return i === -1 ? [...header, line] : header.map((h, j) => (j === i ? line : h))
}

const LINGUI_ESCAPE: Record<string, string> = {
    '\x07': '\\a',
    '\b': '\\b',
    '\t': '\\t',
    '\v': '\\v',
    '\f': '\\f',
    '\r': '\\r',
    '"': '\\"',
    '\\': '\\\\',
}

function linguiEscape(s: string) {
    return s.replace(/[\x07\b\t\v\f\r"\\]/g, (c) => LINGUI_ESCAPE[c])
}

/** A keyword and its text as pofile-ts writes them when lines aren't folded. */
function linguiKeyword(keyword: string, text: string): string[] {
    if (!text.includes('\n')) return [`${keyword} "${linguiEscape(text)}"`]
    const parts = text.split('\n')
    const segments = parts.map((p, i) => linguiEscape(p) + (i < parts.length - 1 ? '\\n' : ''))
    if (parts[0] === '') return [`${keyword} ""`, ...segments.map((s) => `"${s}"`)]
    return [`${keyword} "${segments[0]}"`, ...segments.slice(1).map((s) => `"${s}"`)]
}

/** Writes an app.po as Lingui does. */
export function writeLinguiPo(file: PoFile): string {
    const lines = ['msgid ""', 'msgstr ""', ...file.header.map((h) => `"${h}\\n"`)]
    for (const e of file.entries) {
        lines.push('')
        for (const c of e.comments) lines.push(c ? `# ${c}` : '#')
        for (const c of e.notes) lines.push(c ? `#. ${c}` : '#.')
        for (const r of e.refs) lines.push(`#: ${r}`)
        if (e.flags.length > 0) lines.push(`#, ${e.flags.join(',')}`)
        if (e.ctx !== undefined) lines.push(...linguiKeyword('msgctxt', e.ctx))
        lines.push(...linguiKeyword('msgid', e.id))
        if (e.plural === undefined) {
            lines.push(...linguiKeyword('msgstr', e.strs[0] ?? ''))
        } else {
            lines.push(...linguiKeyword('msgid_plural', e.plural))
            e.strs.forEach((s, i) => lines.push(...linguiKeyword(`msgstr[${i}]`, s)))
        }
    }
    return `${lines.join('\n')}\n`
}

function goQuote(s: string) {
    const escaped = s
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('\n', '\\n')
        .replaceAll('\t', '\\t')
    return `"${escaped}"`
}

/** Writes a core.po as build/i18n does (catalog.String in build/i18n/po.go). */
export function writeGoPo(file: PoFile): string {
    let out = 'msgid ""\nmsgstr ""\n'
    for (const h of file.header) out += `${JSON.stringify(`${h}\n`)}\n`
    for (const e of file.entries) {
        out += '\n'
        for (const c of e.comments) out += `${`# ${c}`.trimEnd()}\n`
        for (const c of e.notes) out += `#. ${c}\n`
        for (const r of e.refs) out += `#: ${r}\n`
        if (e.ctx !== undefined && e.ctx !== '') out += `msgctxt ${goQuote(e.ctx)}\n`
        out += `msgid ${goQuote(e.id)}\n`
        if (e.plural === undefined || e.plural === '') {
            out += `msgstr ${goQuote(e.strs[0] ?? '')}\n`
            continue
        }
        out += `msgid_plural ${goQuote(e.plural)}\n`
        e.strs.forEach((s, i) => {
            out += `msgstr[${i}] ${goQuote(s)}\n`
        })
    }
    return out
}
