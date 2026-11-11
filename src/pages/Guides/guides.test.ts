import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '../../../lib/shell'
import { routeOf } from '../../routes'
import { GUIDES, guideById, matches } from './guides'
import { keyCaps, plainText } from './text'
import { type Action, CATEGORIES } from './types'

const OSES: Platform[] = ['macos', 'windows', 'linux']
const RE_BRACES = /[{}]/

function actions(): Action[] {
    return GUIDES.flatMap((g) => [
        ...(g.open ? [g.open] : []),
        ...g.sections.flatMap((s) =>
            (s.steps ?? []).flatMap((st) => (st.action ? [st.action] : []))
        ),
    ])
}

function texts(): string[] {
    return GUIDES.flatMap((g) => [
        g.title,
        g.summary,
        ...g.sections.flatMap((s) => [
            s.title,
            ...(s.text ?? []),
            ...(s.steps ?? []).map((st) => st.text),
            ...(s.tips ?? []),
        ]),
    ])
}

describe('the guides', () => {
    it('have unique ids, in known groups', () => {
        const ids = GUIDES.map((g) => g.id)
        expect(new Set(ids).size).toBe(ids.length)
        const groups = new Set<string>(CATEGORIES.map((c) => c.id))
        for (const g of GUIDES) expect(groups.has(g.category), g.id).toBe(true)
    })

    it('open windows that exist', () => {
        for (const a of actions()) expect(routeOf(a.route).def, a.route).toBeDefined()
    })

    it('point to guides that exist', () => {
        for (const g of GUIDES) {
            for (const id of g.related ?? []) expect(guideById(id), `${g.id} → ${id}`).toBeDefined()
        }
    })

    it('show each section once on every system', () => {
        for (const os of OSES) {
            for (const g of GUIDES) {
                const titles = g.sections
                    .filter((s) => !s.os || s.os.includes(os))
                    .map((s) => s.title)
                expect(new Set(titles).size, `${g.id} on ${os}`).toBe(titles.length)
            }
        }
    })

    it('close their markup', () => {
        for (const text of texts()) {
            expect((text.match(/\*\*/g) ?? []).length % 2, text).toBe(0)
            expect((text.match(/`/g) ?? []).length % 2, text).toBe(0)
            expect((text.match(/\[\[/g) ?? []).length, text).toBe(
                (text.match(/\]\]/g) ?? []).length
            )
        }
    })

    it('have no braces, which a translated message would read as a placeholder', () => {
        for (const text of texts()) expect(text, text).not.toMatch(RE_BRACES)
    })

    it('keep their translated search words in step with the English ones', () => {
        // The tests run in English, where each translated word is its English one.
        for (const g of GUIDES) {
            for (const word of g.keywords?.translated ?? []) {
                expect(g.keywords?.english, `${g.id}: ${word}`).toContain(word)
            }
        }
    })
})

describe('search', () => {
    afterEach(() => i18n.loadAndActivate({ locale: 'en', messages: {} }))

    const ids = (q: string, os: Platform = 'macos') =>
        GUIDES.filter((g) => matches(g, q, os)).map((g) => g.id)

    it('finds guides by any of their words', () => {
        expect(ids('')).toHaveLength(GUIDES.length)
        expect(ids('public link')).toContain('public-links')
        expect(ids('webdav')).toContain('serve')
        expect(ids('cron')).toContain('schedules')
        expect(ids('zzqxv')).toEqual([])
    })

    it('finds a guide by its English search words in every language', async () => {
        // The guides are read again in a language where these words are translated.
        i18n.loadAndActivate({
            locale: 'es',
            messages: {
                [msg`command palette`.id]: 'paleta de comandos',
                [msg`keyboard`.id]: 'teclado',
            },
        })
        vi.resetModules()
        const spanish = await import('./guides')
        const found = (q: string) =>
            spanish.GUIDES.filter((g) => spanish.matches(g, q, 'macos')).map((g) => g.id)
        expect(spanish.guideById('launcher')?.keywords?.translated).toContain('teclado')
        expect(found('teclado')).toContain('launcher')
        expect(found('Paleta de comandos')).toContain('launcher')
        expect(found('keyboard')).toContain('launcher')
        expect(found('command palette')).toContain('launcher')
        // Names that read the same everywhere are found too.
        expect(found('webdav')).toContain('serve')
    })

    it('leaves out steps meant for other systems', () => {
        expect(ids('nfs client', 'macos')).toContain('mount')
        expect(ids('nfs client', 'linux')).not.toContain('mount')
    })
})

describe('text', () => {
    it('drops the markup for search', () => {
        expect(plainText('Press **New watcher**, then type `~/Photos`.')).toBe(
            'Press New watcher, then type ~/Photos.'
        )
        expect(plainText('Press [[shortcut]], then [[key:K]].')).toBe('Press , then .')
    })

    it("names shortcuts with the system's modifier", () => {
        expect(keyCaps('K', true)).toEqual(['⌘', 'K'])
        expect(keyCaps('K', false)).toEqual(['Ctrl', 'K'])
    })
})
