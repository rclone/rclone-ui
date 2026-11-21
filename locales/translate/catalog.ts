// biome-ignore-all lint/correctness/noNodejsModules: it builds the data in Node, from the vite config
/**
 * Builds the site's data from locales/ (Node only, run by vite.config.ts):
 * - catalog.json: every English text, the pages that list them, and the languages;
 * - <language>.json: the translations that a language ships, and its TERMS.md.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { poId, rcloneId } from './ids.ts'
import { pageOfFile, pageRank, slug } from './pages.ts'
import { headerValue, type PoEntry, parsePo } from './po.ts'
import { flattenTexts } from './rclone.ts'
import type { Catalog, Kind, Page, Row, Shipped } from './types.ts'

/** The text that the start page shows in every language. */
const FEATURED = 'Put the files from one place into another.'

const SPACE = /\s+/
const FIRST_COUNT_FORM =
    /\{\w+, (?:plural|select|selectordinal),\s*(?:\w+|=\d+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/
const GO_FILE = /^(core|app)\//

function read(path: string) {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function refFiles(e: PoEntry) {
    return [...new Set(e.refs.flatMap((r) => r.split(SPACE)).map((r) => r.split(':')[0]))]
}

/**
 * Where text first appears in a file, so that a page lists its texts in the order of the code.
 * The words are looked for with anything between them, such as line breaks, markup and the code's
 * placeholders. A text that isn't found sorts last.
 */
function positionIn(source: string, text: string) {
    const NOT_FOUND = Number.MAX_SAFE_INTEGER
    if (!source) return NOT_FOUND
    // A plural is looked for by its first form, which is how the code lists it too.
    const first = FIRST_COUNT_FORM.exec(text)
    let words = first ? `${text.slice(0, first.index)} ${first[1]}` : text
    words = words.replace(/\{\w*\}|<\/?\d+>|%(?:\[\d+\])?[-+# 0]*\d*(?:\.\d+)?[a-zA-Z]|[{}#]/g, ' ')
    const list = (words.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 6)
    if (list.length === 0) return NOT_FOUND
    const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let match: RegExpExecArray | null
    if (list.length === 1) {
        const w = escape(list[0])
        match =
            new RegExp(`[\`'"]${w}[\`'"]|>\\s*${w}\\s*<`, 'u').exec(source) ??
            new RegExp(`[\`'"]${w}(?![\\p{L}\\p{N}])`, 'u').exec(source)
    } else {
        const between = '(?:\\$?\\{[^{}]*\\}|%[a-zA-Z]|[^\\p{L}\\p{N}])+'
        match = new RegExp(list.map(escape).join(between), 'u').exec(source)
    }
    return match ? match.index : NOT_FOUND
}

interface Placed {
    index: number
    page: string
    group: string
    position: number
}

function rcloneHeading(key: string[]) {
    if (key[0] === 'options' || key[0] === 'setup') return key[1]
    if (key[2] === 'option' && key.length > 3) return key[3]
    return key[2] ?? key[1]
}

export function buildData(repo: string): Map<string, string> {
    const locales = join(repo, 'locales')
    const names = JSON.parse(read(join(locales, 'languages.json'))) as Record<string, string>
    const enApp = parsePo(read(join(locales, 'en', 'app.po')))
    const enCore = parsePo(read(join(locales, 'en', 'core.po')))
    const enRclone = flattenTexts(JSON.parse(read(join(locales, 'en', 'rclone.json')) || '{}'))

    const rows: Row[] = []
    const placed: Placed[] = []
    const sources = new Map<string, string>()
    const sourceOf = (file: string) => {
        if (!sources.has(file)) sources.set(file, read(join(repo, file)))
        return sources.get(file) ?? ''
    }

    for (const [kind, file] of [
        ['app', enApp],
        ['core', enCore],
    ] as const) {
        for (const e of file.entries) {
            const files = refFiles(e)
            const pages = [...new Set(files.map(pageOfFile))].sort(
                (a, b) => pageRank(a) - pageRank(b)
            )
            const page = pages[0] ?? 'Errors and other messages'
            const where = files.find((f) => pageOfFile(f) === page) ?? ''
            const row: Row = {
                id: poId(kind, e.ctx ?? '', e.id, e.plural ?? ''),
                kind,
                text: e.id,
                group: where,
            }
            if (e.plural) row.plural = e.plural
            if (e.ctx !== undefined) row.ctx = e.ctx
            if (e.notes.length > 0) row.notes = e.notes
            if (e.refs.length > 0) row.refs = e.refs
            if (pages.length > 1) row.also = pages.slice(1).map(slug)
            placed.push({
                index: rows.length,
                page,
                group: where,
                position: positionIn(sourceOf(where), e.id),
            })
            rows.push(row)
        }
    }

    const pages: Page[] = []
    const byTitle = new Map<string, Page>()
    const pageFor = (title: string, part: Page['part'], id = slug(title)) => {
        let page = byTitle.get(id)
        if (!page) {
            page = { id, title, part, rows: [] }
            byTitle.set(id, page)
            pages.push(page)
        }
        return page
    }
    placed.sort(
        (a, b) =>
            pageRank(a.page) - pageRank(b.page) ||
            Number(GO_FILE.test(a.group)) - Number(GO_FILE.test(b.group)) ||
            a.group.localeCompare(b.group) ||
            a.position - b.position ||
            rows[a.index].text.toLowerCase().localeCompare(rows[b.index].text.toLowerCase())
    )
    for (const p of placed) pageFor(p.page, 'app').rows.push(p.index)

    const descriptions = new Map(
        enRclone
            .filter(([key]) => key[0] === 'backend' && key.length === 3 && key[2] === 'description')
            .map(([key, text]) => [key[1], text])
    )
    for (const [key, text] of enRclone) {
        const page =
            key[0] === 'setup'
                ? pageFor('Setup questions', 'rclone', 'rclone-setup')
                : key[0] === 'options'
                  ? pageFor('Global options', 'rclone', 'rclone-options')
                  : pageFor(key[1], 'rclone', `rclone-${slug(key[1])}`)
        if (key[0] === 'backend' && !page.about) page.about = descriptions.get(key[1])
        page.rows.push(rows.length)
        rows.push({ id: rcloneId(key, text), kind: 'rclone', text, key, group: rcloneHeading(key) })
    }
    // The backends follow the setup questions and the global options, A to Z.
    const rcloneFirst = ['rclone-setup', 'rclone-options']
    pages.sort((a, b) => {
        if (a.part !== b.part) return a.part === 'app' ? -1 : 1
        if (a.part === 'app') return 0
        const ra = rcloneFirst.indexOf(a.id)
        const rb = rcloneFirst.indexOf(b.id)
        if (ra !== -1 || rb !== -1) return (ra === -1 ? 9 : ra) - (rb === -1 ? 9 : rb)
        return a.title.localeCompare(b.title)
    })

    const ids = new Set(rows.map((r) => r.id))
    if (ids.size !== rows.length) throw new Error('translate: two texts have the same id')

    const out = new Map<string, string>()
    const featuredRow = rows.find((r) => r.kind === 'app' && r.text === FEATURED) ?? rows[0]
    const catalog: Catalog = {
        built: new Date().toISOString().slice(0, 10),
        appHeader: enApp.header,
        rows,
        pages,
        languages: [],
        names,
        featured: { text: featuredRow.text, translations: {} },
    }

    for (const tag of Object.keys(names)) {
        if (tag === 'en') continue
        const shipped = readLanguage(locales, tag, rows)
        catalog.languages.push({ tag, name: names[tag], pluralForms: shipped.pluralForms })
        const featured = shipped.values[featuredRow.id]?.[0]
        if (featured) catalog.featured.translations[tag] = featured
        out.set(tag, JSON.stringify(shipped))
    }
    out.set('catalog', JSON.stringify(catalog))
    return out
}

function readLanguage(locales: string, tag: string, rows: Row[]): Shipped {
    const values: Record<string, string[]> = {}
    const app = parsePo(read(join(locales, tag, 'app.po')))
    const core = parsePo(read(join(locales, tag, 'core.po')))
    const add = (kind: Kind, e: PoEntry) => {
        if (e.strs.some((s) => s !== '')) {
            values[poId(kind as 'app' | 'core', e.ctx ?? '', e.id, e.plural ?? '')] = e.strs
        }
    }
    for (const e of app.entries) add('app', e)
    for (const e of core.entries) add('core', e)
    const rclone = read(join(locales, tag, 'rclone.json'))
    for (const [key, text] of flattenTexts(JSON.parse(rclone || '{}'))) {
        values[`rclone\u0000${key.join('\u0000')}`] = [text]
    }
    // An rclone text is matched by its key, as rclone.json keys it, and gets the id of the English
    // text at that key. A key that English no longer has is dropped.
    const known = new Set<string>()
    for (const row of rows) {
        known.add(row.id)
        if (row.kind !== 'rclone' || !row.key) continue
        const k = `rclone\u0000${row.key.join('\u0000')}`
        if (values[k]) values[row.id] = values[k]
    }
    for (const id of Object.keys(values)) if (!known.has(id)) delete values[id]
    const shipped: Shipped = {
        pluralForms: headerValue(core.header, 'Plural-Forms') || 'nplurals=2; plural=(n != 1);',
        values,
    }
    const terms = read(join(locales, tag, 'TERMS.md'))
    if (terms) shipped.terms = terms
    return shipped
}
