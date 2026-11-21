import { useSyncExternalStore } from 'react'

/** A translator's work on one language, which is kept in the browser until it is downloaded. */
export interface Work {
    tag: string
    name: string
    pluralForms: string
    /** The texts that differ from what the language ships, by row id. */
    edits: Record<string, string[]>
    updated: number
}

/** Reads one of the site's data files: catalog.json, or a language's texts. */
export async function fetchData<T>(name: string): Promise<T> {
    const r = await fetch(`./data/${encodeURIComponent(name)}.json`)
    if (!r.ok) throw new Error(`${name}: ${r.status}`)
    return (await r.json()) as T
}

const PREFIX = 'rclone-ui-translate:'
const PREFS = 'rclone-ui-translate-prefs'

export function loadWork(tag: string): Work | null {
    try {
        const text = localStorage.getItem(PREFIX + tag)
        return text ? (JSON.parse(text) as Work) : null
    } catch {
        return null
    }
}

/** Saves the work, and reports whether the browser had room for it. */
export function saveWork(work: Work): boolean {
    try {
        localStorage.setItem(PREFIX + work.tag, JSON.stringify(work))
        return true
    } catch {
        return false
    }
}

export function removeWork(tag: string) {
    localStorage.removeItem(PREFIX + tag)
}

export function savedWork(): Work[] {
    const out: Work[] = []
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key?.startsWith(PREFIX)) continue
        const work = loadWork(key.slice(PREFIX.length))
        if (work) out.push(work)
    }
    return out.sort((a, b) => b.updated - a.updated)
}

export interface Prefs {
    /** Another language to show under each English text. */
    reference: string
}

export function loadPrefs(): Prefs {
    try {
        return {
            reference: '',
            ...(JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>),
        }
    } catch {
        return { reference: '' }
    }
}

export function savePrefs(prefs: Prefs) {
    try {
        localStorage.setItem(PREFS, JSON.stringify(prefs))
    } catch {
        // The preference is lost on reload, which is fine.
    }
}

/** The language and page in the address, as #/<language>/<page>. */
export interface Route {
    tag: string
    page: string
}

const HASH = /^#\/?/

function readRoute(): Route {
    const [tag = '', page = ''] = decodeURIComponent(location.hash.replace(HASH, '')).split('/')
    return { tag, page }
}

let route = readRoute()
const listeners = new Set<() => void>()
window.addEventListener('hashchange', () => {
    route = readRoute()
    for (const l of listeners) l()
})

export function useRoute(): Route {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        () => route
    )
}

export function go(tag = '', page = '') {
    location.hash = tag ? `/${tag}${page ? `/${page}` : ''}` : '/'
}
