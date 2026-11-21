import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { poId, rcloneId } from './ids.ts'
import { formCount } from './plurals.ts'
import {
    headerValue,
    type PoEntry,
    type PoFile,
    parsePo,
    withHeader,
    writeGoPo,
    writeLinguiPo,
} from './po.ts'
import { flattenTexts, type Texts, writeTexts } from './rclone.ts'
import type { Catalog, Row } from './types.ts'

export interface Translation {
    tag: string
    name: string
    pluralForms: string
    /** Every translated text by row id: one string, or one per form of a core.po count. */
    values: (id: string) => string[] | undefined
}

function entryOf(row: Row, strs: string[]): PoEntry {
    return {
        comments: [],
        notes: row.notes ?? [],
        refs: row.refs ?? [],
        flags: [],
        ctx: row.ctx,
        id: row.text,
        plural: row.plural,
        strs,
    }
}

/** The language's files, by their path in the repository. */
export function languageFiles(catalog: Catalog, t: Translation): Record<string, string> {
    const app: PoFile = { header: withHeader(catalog.appHeader, 'Language', t.tag), entries: [] }
    const core: PoFile = {
        header: [
            'Content-Type: text/plain; charset=utf-8',
            `Language: ${t.tag}`,
            `Plural-Forms: ${t.pluralForms}`,
        ],
        entries: [],
    }
    const forms = formCount(t.pluralForms)
    const rclone: Texts = []
    for (const row of catalog.rows) {
        const v = t.values(row.id)
        if (row.kind === 'app') app.entries.push(entryOf(row, [v?.[0] ?? '']))
        else if (row.kind === 'core') {
            const n = row.plural ? forms : 1
            core.entries.push(
                entryOf(
                    row,
                    Array.from({ length: n }, (_, i) => v?.[i] ?? '')
                )
            )
        } else if (row.key && v?.[0]) rclone.push([row.key, v[0]])
    }
    const dir = `locales/${t.tag}`
    const files: Record<string, string> = {
        [`${dir}/app.po`]: writeLinguiPo(app),
        [`${dir}/core.po`]: writeGoPo(core),
    }
    if (rclone.length > 0) files[`${dir}/rclone.json`] = writeTexts(rclone)
    return files
}

export interface Bundle {
    catalog: Catalog
    translation: Translation
    isNew: boolean
    counts: { done: number; total: number; rcloneDone: number; rcloneTotal: number }
}

function readme(b: Bundle) {
    const { tag, name } = b.translation
    const c = b.counts
    const lines = [
        `# Rclone UI in ${name} (${tag})`,
        '',
        `Made on the translation site on ${new Date().toISOString().slice(0, 10)}, from the texts of ${b.catalog.built}.`,
        '',
        `- The app: ${c.done} of ${c.total} texts`,
        `- rclone's help texts: ${c.rcloneDone} of ${c.rcloneTotal} texts`,
        '',
        'To add it, unzip this file at the root of the repository, then run:',
        '',
        '```sh',
        'npm run i18n',
        'go run ./build/i18n -check',
        '```',
    ]
    if (b.isNew) {
        lines.push('', 'locales/languages.json in this file lists the new language.')
    }
    return `${lines.join('\n')}\n`
}

export function makeZip(b: Bundle): Uint8Array {
    const files = languageFiles(b.catalog, b.translation)
    if (b.isNew) {
        const names = { ...b.catalog.names, [b.translation.tag]: b.translation.name }
        const sorted = Object.fromEntries(
            Object.entries(names).sort(([a], [z]) =>
                a === 'en' ? -1 : z === 'en' ? 1 : a.localeCompare(z)
            )
        )
        files['locales/languages.json'] = `${JSON.stringify(sorted, null, 4)}\n`
    }
    files['TRANSLATION.md'] = readme(b)
    return zipSync(Object.fromEntries(Object.entries(files).map(([p, text]) => [p, strToU8(text)])))
}

const LANGUAGE_FILE = /locales\/([^/]+)\/[^/]+$/

export interface Opened {
    tag?: string
    pluralForms?: string
    values: Record<string, string[]>
}

/**
 * Reads files that the site made, or the files of locales/<language>: a .zip, app.po, core.po or
 * rclone.json. A .po file is told apart by its texts' ids, which are only in the app or in core.
 */
export function readFiles(catalog: Catalog, files: { name: string; data: Uint8Array }[]): Opened {
    const out: Opened = { values: {} }
    const keys = new Map(
        catalog.rows.filter((r) => r.key).map((r) => [r.key?.join('\u0000'), r.id] as const)
    )
    const texts = new Map(catalog.rows.map((r) => [r.id, r]))

    const readPo = (text: string) => {
        const po = parsePo(text)
        out.tag ||= headerValue(po.header, 'Language') || undefined
        // Some texts are in both files, so the file is the one that most of its texts are in.
        const known = (kind: 'app' | 'core') =>
            po.entries.filter((e) => texts.has(poId(kind, e.ctx ?? '', e.id, e.plural ?? '')))
                .length
        const kind = known('app') > known('core') ? 'app' : 'core'
        const forms = headerValue(po.header, 'Plural-Forms')
        if (kind === 'core' && forms) out.pluralForms = forms
        for (const e of po.entries) {
            const id = poId(kind, e.ctx ?? '', e.id, e.plural ?? '')
            if (texts.has(id) && e.strs.some((s) => s !== '')) out.values[id] = e.strs
        }
    }
    const readJson = (text: string) => {
        for (const [key, value] of flattenTexts(JSON.parse(text))) {
            const id = keys.get(key.join('\u0000'))
            const row = id ? texts.get(id) : undefined
            if (row?.key && rcloneId(row.key, row.text) === id) out.values[row.id] = [value]
        }
    }
    const readOne = (name: string, data: Uint8Array) => {
        const tagFromPath = LANGUAGE_FILE.exec(name)?.[1]
        if (tagFromPath && tagFromPath !== 'en') out.tag ||= tagFromPath
        if (name.endsWith('.po')) readPo(strFromU8(data))
        else if (name.endsWith('rclone.json')) readJson(strFromU8(data))
    }
    for (const f of files) {
        if (f.name.endsWith('.zip')) {
            for (const [name, data] of Object.entries(unzipSync(f.data))) readOne(name, data)
        } else readOne(f.name, f.data)
    }
    return out
}
