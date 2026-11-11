// The windows' language (locales/README.md). The English text in the code is each message's key:
//
//     t`Start mount`                           a string
//     <Trans>Press <b>Start</b></Trans>        text with markup inside
//     plural(count, { one: '# file', other: '# files' })
//
// `npm run i18n` collects the messages into locales/<language>/app.po, and each language is
// loaded as its own chunk.
//
// A window has one language from its first line of code to its last. src/boot.ts loads the
// language before it loads the app, so text may be translated anywhere, including at the top of a
// module. When the language changes, the window loads again in the new one (main.tsx), so nothing
// that was worked out in the old language stays on show.
//
// The language is the `general.language` setting, or the system's when that is empty. A window
// starts in the language that the last window used (localStorage), and loads again if the
// setting says otherwise, which only happens after the data folder was changed.

import { i18n, type Messages } from '@lingui/core'
import names from '../locales/languages.json'

/** The language of the text in the code, and the fallback for anything else. */
export const ENGLISH = 'en'

/**
 * The test language: English with accents, in brackets. Text that shows without them was never
 * marked for translation. Only a dev build offers it.
 */
export const PSEUDO = 'pseudo'

/** The app's languages, each under its own name, in the order that Settings lists them. */
export const LANGUAGES: Readonly<Record<string, string>> = names

/** Each language's catalog, which Vite compiles from its .po file and loads when asked. */
const catalogs = import.meta.glob<{ messages: Messages }>('../locales/*/app.po')

/** Where a window finds the language to start in. */
const STORAGE_KEY = 'language'

/** The language that a setting gives: itself when the app has it, the system's when empty. */
export function languageOf(setting: string | undefined, system: string): string {
    if (!setting) return system
    return setting === PSEUDO || Object.hasOwn(LANGUAGES, setting) ? setting : ENGLISH
}

/** The language that a window starts in: the last one used here, or else the system's. */
export function startLanguage(system: string): string {
    try {
        return languageOf(localStorage.getItem(STORAGE_KEY) ?? '', system)
    } catch {
        return system
    }
}

export function language(): string {
    return i18n.locale || ENGLISH
}

/**
 * The language for the browser's own formatting and for the page's `lang`: the window's language,
 * or English for the test language, which no browser knows.
 */
export function locale(): string {
    const lang = language()
    return lang === PSEUDO ? ENGLISH : lang
}

/**
 * Loads a language and makes it the window's, before the app loads (src/boot.ts). A language
 * without a catalog gives English. The page's `lang` follows, for the fonts and line breaks of
 * the language.
 */
export async function activateLanguage(lang: string): Promise<void> {
    const path = (l: string) => `../locales/${l}/app.po`
    const load = catalogs[path(lang)] ?? catalogs[path(ENGLISH)]
    const { messages } = await load()
    i18n.loadAndActivate({ locale: lang, messages })
    document.documentElement.lang = locale()
}

/**
 * Makes `lang` the language that the next window starts in, and loads this window again in it.
 * It does nothing when the window is in that language already.
 */
export function switchLanguage(lang: string): void {
    if (lang === language()) return
    try {
        localStorage.setItem(STORAGE_KEY, lang)
    } catch {
        // Without storage the window would load again in the same language, and again.
        return
    }
    window.location.reload()
}
