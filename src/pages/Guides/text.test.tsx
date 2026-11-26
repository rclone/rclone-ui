import { extractFromFileWithBabel } from '@lingui/cli/api'
import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { GUIDES } from './guides'
import guidesSource from './guides.ts?raw'
import indexSource from './index.tsx?raw'
import { GuideText, KeyboardContext } from './text'

const MESSAGE = 'Press [[shortcut]], then [[key:K]] on `gdrive:Photos`.'
const RE_KBD = /<kbd[^>]*>([^<]*)<\/kbd>/g
const RE_BRACE_KEY = /\{(shortcut|key:)/

function render(text: string, mac = true): string {
    return renderToStaticMarkup(
        <KeyboardContext.Provider value={{ shortcut: ['⌥', 'Space'], mac }}>
            <GuideText text={text} />
        </KeyboardContext.Provider>
    )
}

function caps(html: string): string[] {
    return [...html.matchAll(RE_KBD)].map((match) => match[1])
}

describe('the keys in a message', () => {
    afterEach(() => i18n.loadAndActivate({ locale: 'en', messages: {} }))

    it('come through t as they are written', () => {
        expect(t`Press [[shortcut]], then [[key:K]] on \`gdrive:Photos\`.`).toBe(MESSAGE)
        expect(caps(render(MESSAGE))).toEqual(['⌥', 'Space', '⌘', 'K'])
        expect(caps(render(MESSAGE, false))).toEqual(['⌥', 'Space', 'Ctrl', 'K'])
        expect(render(MESSAGE)).toContain('<code')
        expect(render(MESSAGE)).not.toContain('[[')
        expect(t`Press {shortcut}.`).toBe('Press .')
    })

    it('stay keys in the test language, which accents their letters', () => {
        const pseudo = 'Ƥŕēśś [[śĥōŕţćũţ]], ţĥēń [[ķēŷ:Ķ]].'
        expect(caps(render(pseudo))).toEqual(['⌥', 'Space', '⌘', 'K'])
        expect(render(pseudo)).not.toContain('[[')
    })

    it('stay keys where a translation moves them', () => {
        const message = msg`Press [[shortcut]], then [[key:K]] on \`gdrive:Photos\`.`
        expect(message.message).toBe(MESSAGE)
        i18n.loadAndActivate({
            locale: 'es',
            messages: { [message.id]: 'En `gdrive:Photos`, [[key:K]] después de [[shortcut]].' },
        })
        const translated = i18n._(message)
        expect(translated).toBe('En `gdrive:Photos`, [[key:K]] después de [[shortcut]].')
        expect(caps(render(translated))).toEqual(['⌘', 'K', '⌥', 'Space'])
    })

    it('are in the extracted messages as they are written, for translators to keep', async () => {
        const extracted: string[] = []
        const sources = { 'guides.ts': guidesSource, 'index.tsx': indexSource }
        for (const [file, code] of Object.entries(sources)) {
            await extractFromFileWithBabel(
                file,
                code,
                (message) => extracted.push(message.message ?? ''),
                // Without a config, the extractor loads lingui.config.ts.
                { linguiConfig: undefined as never },
                { plugins: ['typescript', 'jsx'] }
            )
        }
        const launcher = GUIDES.find((g) => g.id === 'launcher')
        expect(extracted).toContain(launcher?.summary)
        expect(extracted.some((message) => message.includes('[[shortcut]]'))).toBe(true)
        expect(extracted.some((message) => message.includes('[[key:K]]'))).toBe(true)
        expect(extracted.length).toBeGreaterThan(200)
        for (const message of extracted) expect(message, message).not.toMatch(RE_BRACE_KEY)
    })
})
