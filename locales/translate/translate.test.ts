// biome-ignore-all lint/correctness/noNodejsModules: the tests read the files in locales/
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from '@messageformat/parser'
import { strToU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildData } from './catalog.ts'
import { checkRow, icuPlaceholders } from './checks.ts'
import { languageFiles, makeZip, readFiles } from './files.ts'
import { evaluateRule, gettextExamples, gettextRule, withForms } from './plurals.ts'
import { parsePo, writeGoPo, writeLinguiPo } from './po.ts'
import type { Catalog, Row, Shipped } from './types.ts'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const data = buildData(repo)
const catalog = JSON.parse(data.get('catalog') ?? '') as Catalog
const file = (path: string) => readFileSync(`${repo}/${path}`, 'utf8')

function shipped(tag: string) {
    const s = JSON.parse(data.get(tag) ?? '') as Shipped
    const name = catalog.languages.find((l) => l.tag === tag)?.name ?? tag
    return { tag, name, pluralForms: s.pluralForms, values: (id: string) => s.values[id] }
}

describe('files', () => {
    it('writes the English catalogs as their tools do', () => {
        for (const name of ['app', 'core']) {
            const text = file(`locales/en/${name}.po`)
            const write = name === 'app' ? writeLinguiPo : writeGoPo
            expect(write(parsePo(text))).toBe(text)
        }
    })

    it.each(['es', 'zh-CN'])('writes %s as the repository has it', (tag) => {
        const files = languageFiles(catalog, shipped(tag))
        expect(files[`locales/${tag}/app.po`]).toBe(file(`locales/${tag}/app.po`))
        expect(files[`locales/${tag}/core.po`]).toBe(file(`locales/${tag}/core.po`))
        expect(files[`locales/${tag}/rclone.json`]).toBe(file(`locales/${tag}/rclone.json`))
    })

    it('reads back the zip that it makes', () => {
        const translation = shipped('es')
        const zip = makeZip({
            catalog,
            translation,
            isNew: false,
            counts: { done: 0, total: 0, rcloneDone: 0, rcloneTotal: 0 },
        })
        expect(Object.keys(unzipSync(zip)).sort()).toEqual([
            'TRANSLATION.md',
            'locales/es/app.po',
            'locales/es/core.po',
            'locales/es/rclone.json',
        ])
        const opened = readFiles(catalog, [{ name: 'rclone-ui-es.zip', data: zip }])
        expect(opened.tag).toBe('es')
        expect(opened.pluralForms).toBe('nplurals=2; plural=(n != 1);')
        const want = JSON.parse(data.get('es') ?? '') as Shipped
        expect(opened.values).toEqual(want.values)
    })

    it('lists a new language in languages.json', () => {
        const zip = makeZip({
            catalog,
            translation: {
                tag: 'fr',
                name: 'Français',
                pluralForms: gettextRule('fr'),
                values: () => undefined,
            },
            isNew: true,
            counts: { done: 0, total: 0, rcloneDone: 0, rcloneTotal: 0 },
        })
        const files = unzipSync(zip)
        const names = JSON.parse(
            new TextDecoder().decode(files['locales/languages.json'])
        ) as object
        expect(Object.keys(names)).toEqual(['en', 'es', 'fr', 'zh-CN'])
        expect(new TextDecoder().decode(files['TRANSLATION.md'])).toContain(
            '# Rclone UI in Français (fr)'
        )
        expect(files['locales/fr/rclone.json']).toBeUndefined()
        const core = parsePo(new TextDecoder().decode(files['locales/fr/core.po']))
        expect(core.header).toContain('Plural-Forms: nplurals=2; plural=(n > 1);')
    })

    it('reads a single app.po', () => {
        const opened = readFiles(catalog, [
            { name: 'app.po', data: strToU8(file('locales/zh-CN/app.po')) },
        ])
        expect(opened.tag).toBe('zh-CN')
        const app = catalog.rows.filter((r) => r.kind === 'app')
        expect(Object.keys(opened.values).length).toBe(app.length)
    })
})

describe('catalog', () => {
    it('puts every text on one page', () => {
        const listed = catalog.pages.flatMap((p) => p.rows)
        expect(listed.length).toBe(catalog.rows.length)
        expect(new Set(listed).size).toBe(catalog.rows.length)
    })
})

const row = (r: Partial<Row>): Row => ({ id: 'x', kind: 'app', text: '', group: '', ...r })

describe('checks', () => {
    it('finds the placeholders that -check finds', () => {
        expect(
            [
                ...icuPlaceholders(
                    '{count, plural, one {# file in {where}} other {<0>#</0> files}}'
                ),
            ].sort()
        ).toEqual(['<0>', '{count}', '{where}'])
        expect([...icuPlaceholders('{n, plural, one {Yes, with # rule} other {No}}')]).toEqual([
            '{n}',
        ])
    })

    it('reports a missing value, broken braces and a missing other', () => {
        const app = row({ text: 'Delete {name}?' })
        expect(checkRow(app, ['¿Eliminar?'], 'es')[0].message).toContain('Keep {name}')
        expect(checkRow(app, ['¿Eliminar {name?'], 'es')[0].level).toBe('error')
        expect(checkRow(app, ['¿Eliminar {name}?'], 'es')).toEqual([])
        const count = row({ text: '{n, plural, one {# file} other {# files}}' })
        expect(checkRow(count, ['{n, plural, one {# plik}}'], 'pl').map((p) => p.level)).toContain(
            'error'
        )
        const pl = checkRow(count, ['{n, plural, one {# plik} other {# plików}}'], 'pl')
        expect(pl.map((p) => p.message).join(' ')).toContain('few (2, 3, 4, 22…)')
    })

    it('checks Go formats by position', () => {
        const core = row({ kind: 'core', text: '"%s" on %s is a file' })
        expect(checkRow(core, ['%[2]s 上的“%[1]s”是文件'], 'zh-CN')).toEqual([])
        expect(checkRow(core, ['%s 上是文件'], 'zh-CN')[0].message).toContain('Keep %s')
    })
})

describe('plurals', () => {
    it('evaluates gettext rules', () => {
        const pl = gettextRule('pl')
        expect([1, 2, 5, 22, 25, 112].map((n) => evaluateRule(pl, n))).toEqual([0, 1, 2, 1, 2, 2])
        expect(gettextExamples(pl)).toEqual(['1', '2, 3, 4, 22…', '0, 5, 6, 7…'])
        expect(gettextRule('pt-BR')).toBe('nplurals=2; plural=(n > 1);')
        expect(gettextRule('zh-TW')).toBe('nplurals=1; plural=0;')
    })

    it('gives each count the forms of the language', () => {
        const en = '{count, plural, one {# file} other {# files}} in {where}'
        expect(withForms(en, 'zh-CN')).toBe('{count, plural, other {# files}} in {where}')
        expect(withForms(en, 'pl')).toBe(
            '{count, plural, one {# file} few {# files} many {# files} other {# files}} in {where}'
        )
        for (const r of catalog.rows.filter(
            (x) => x.kind === 'app' && x.text.includes('plural,')
        )) {
            const out = withForms(r.text, 'en')
            expect(() => parse(out)).not.toThrow()
            expect(icuPlaceholders(out)).toEqual(icuPlaceholders(r.text))
        }
    })
})
