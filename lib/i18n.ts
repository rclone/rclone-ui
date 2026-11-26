import { i18n, type Messages } from '@lingui/core'
import names from '../locales/languages.json'

export const ENGLISH = 'en'

export const PSEUDO = 'pseudo'

export const LANGUAGES: Readonly<Record<string, string>> = names

const catalogs = import.meta.glob<{ messages: Messages }>('../locales/*/app.po')

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
        return
    }
    window.location.reload()
}
