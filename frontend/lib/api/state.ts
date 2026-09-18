// zustand `persist` storage over the server's state documents (`/api/state/<doc>`). Reads the
// whole document; writes only the top-level keys the page itself changed, with `If-Match` so a
// stale page can never clobber another writer — on 409 it adopts the newer revision, re-applies
// its own keys and retries once. Rust writers (the lifecycle) patch the same documents; every
// change is announced as `state.changed`, which `watchDoc` turns into a rehydrate.
//
// Two things are kept apart, because they are not the same. `known` is the server's document as
// last seen: the revision a write is conditioned on. `mine` is the state this page's store last
// read or wrote: what its changes are measured against. A page that has not caught up with
// another writer holds that writer's keys at their old values; measured against the server's
// document those would read as changes of its own, and be written back over the newer ones.

import type { StateStorage } from 'zustand/middleware'
import { on } from './events'
import { sessionId } from './ws'

interface StateDoc {
    version: number
    revision: number
    state: Record<string, unknown>
}

interface PersistValue {
    state: Record<string, unknown>
    version?: number
}

const known = new Map<string, StateDoc>()
const mine = new Map<string, Record<string, unknown>>()
// Documents of which this page adopted a revision its store has not read (a refused write told
// it of another writer). The next announcement rehydrates the store, even one that is not newer
// than `known`: the store is what is behind, not the adapter.
const behind = new Set<string>()

async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(path, {
        ...init,
        credentials: 'same-origin',
        headers: { 'X-RcloneUI-Session': sessionId, ...(init.headers ?? {}) },
    })
    if (response.status === 401 && window.location.pathname !== '/login') {
        window.location.assign('/login')
    }
    return response
}

async function read(doc: string): Promise<StateDoc | null> {
    const response = await request(`/api/state/${doc}`)
    if (!response.ok) throw new Error(`state ${doc}: HTTP ${response.status}`)
    const parsed = (await response.json()) as StateDoc
    // Revision 0 = never written: the page starts from its defaults and its first write PUTs.
    if (parsed.revision === 0) {
        known.delete(doc)
        return null
    }
    known.set(doc, parsed)
    return parsed
}

/**
 * The keys to `set` (new or changed) and to `unset` (in the page's last state, gone from this
 * one: a page clears a value by setting it to `undefined`, which JSON drops).
 */
function changedKeys(previous: Record<string, unknown> | undefined, next: Record<string, unknown>) {
    const set: Record<string, unknown> = {}
    const unset: string[] = []
    for (const [key, value] of Object.entries(next)) {
        if (value === undefined) continue
        if (!previous || JSON.stringify(previous[key]) !== JSON.stringify(value)) set[key] = value
    }
    for (const key of Object.keys(previous ?? {})) {
        if (next[key] === undefined) unset.push(key)
    }
    return { set, unset }
}

// A page's own writes to one document go one after another: each starts from the revision the
// previous one produced, so they never race each other. The 409 path in `writeNow` is for other
// writers (another tab, the Rust side).
const queues = new Map<string, Promise<void>>()

async function write(doc: string, value: PersistValue): Promise<void> {
    const previous = queues.get(doc) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => writeNow(doc, value))
    queues.set(doc, run)
    try {
        await run
    } finally {
        if (queues.get(doc) === run) queues.delete(doc)
    }
}

async function writeNow(doc: string, value: PersistValue): Promise<void> {
    const version = value.version ?? 0
    // What this page's state came from. None: it hydrated an unwritten document, and holds its
    // defaults and whatever it has set since.
    const base = mine.get(doc)
    let current = known.get(doc) ?? (await read(doc))
    let set: Record<string, unknown>
    let unset: string[] = []
    // Another page created the document first. Its values stand: this page's whole state is
    // mostly defaults, and writing them over would undo the other page's changes. Only the keys
    // it does not have yet go on top.
    const lacking = (theirs: StateDoc) =>
        Object.fromEntries(
            Object.entries(value.state).filter(
                ([key, item]) => item !== undefined && !(key in theirs.state)
            )
        )
    if (!current || current.version !== version) {
        // First write, or a migration changed the schema version: replace the document, on the
        // condition that nobody else has since (revision 0 = never written).
        const response = await request(`/api/state/${doc}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'If-Match': String(current?.revision ?? 0),
            },
            body: JSON.stringify({ version, state: value.state }),
        })
        if (response.status !== 409) {
            if (!response.ok) throw new Error(`state ${doc}: PUT failed (${response.status})`)
            known.set(doc, (await response.json()) as StateDoc)
            mine.set(doc, value.state)
            return
        }
        const theirs = (await response.json()) as StateDoc
        known.set(doc, theirs)
        behind.add(doc)
        current = theirs
        set = lacking(theirs)
    } else if (!base) {
        // The same, found out one request earlier: the document was unwritten when this page
        // hydrated it and exists now. Which of the two a page meets is a matter of timing, so
        // they must not differ in what they do.
        behind.add(doc)
        set = lacking(current)
    } else {
        ;({ set, unset } = changedKeys(base, value.state))
    }
    if (Object.keys(set).length === 0 && unset.length === 0) {
        mine.set(doc, value.state)
        return
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        const at = known.get(doc) ?? current
        const response = await request(`/api/state/${doc}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'If-Match': String(at.revision) },
            body: JSON.stringify({ set, unset }),
        })
        if (response.status === 409) {
            // Someone else wrote first: adopt their revision and re-apply our keys on top. What
            // they changed is theirs; the store learns of it from the rehydrate this asks for.
            known.set(doc, (await response.json()) as StateDoc)
            behind.add(doc)
            continue
        }
        if (!response.ok) throw new Error(`state ${doc}: PATCH failed (${response.status})`)
        known.set(doc, (await response.json()) as StateDoc)
        mine.set(doc, value.state)
        return
    }
    throw new Error(`state ${doc}: lost the write race twice`)
}

/**
 * A zustand `StateStorage` for one document. `resolveDoc` is called on every operation so the
 * host store can swap documents; `null` makes every operation a no-op (getItem → null).
 */
export function stateStorage(resolveDoc: () => string | null): StateStorage {
    // The documents this store has read. A write before that read would carry the store's
    // defaults (a page's first render can set state before hydration lands) and patch them
    // over what other pages saved; such a write is dropped, and hydration brings the truth.
    const hydrated = new Set<string>()
    return {
        getItem: async () => {
            const doc = resolveDoc()
            if (!doc) return null
            const current = await read(doc)
            hydrated.add(doc)
            // The store's state is this document from here on.
            behind.delete(doc)
            if (!current) {
                mine.delete(doc)
                return null
            }
            mine.set(doc, current.state)
            return JSON.stringify({ state: current.state, version: current.version })
        },
        setItem: async (_name, value) => {
            const doc = resolveDoc()
            if (!doc) return
            if (!hydrated.has(doc)) {
                console.warn(`[state] dropped a write to ${doc} before it was read`)
                return
            }
            await write(doc, JSON.parse(value) as PersistValue)
        },
        removeItem: async () => {
            const doc = resolveDoc()
            if (!doc) return
            const response = await request(`/api/state/${doc}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version: known.get(doc)?.version ?? 0, state: {} }),
            })
            if (response.ok) {
                known.set(doc, (await response.json()) as StateDoc)
                mine.set(doc, {})
            }
        },
    }
}

/** Replaces a document wholesale (the persisted store's v1→v2 migration writes the host doc). */
export async function putDoc(
    doc: string,
    version: number,
    state: Record<string, unknown>
): Promise<void> {
    const response = await request(`/api/state/${doc}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, state }),
    })
    if (!response.ok) throw new Error(`state ${doc}: PUT failed (${response.status})`)
    known.set(doc, (await response.json()) as StateDoc)
    mine.set(doc, state)
}

/**
 * Calls `rehydrate` whenever another writer (a page, the lifecycle) changed the document. Our
 * own writes are recognised by revision and ignored.
 */
export function watchDoc(
    resolveDoc: () => string | null,
    rehydrate: () => Promise<void> | void
): () => void {
    return on('state.changed', (change) => {
        const doc = resolveDoc()
        if (!doc || change.doc !== doc) return
        const current = known.get(doc)
        if (current && change.revision <= current.revision && !behind.has(doc)) return
        Promise.resolve(rehydrate()).catch((error) =>
            console.error(`[state] rehydrate ${doc} failed`, error)
        )
    })
}

/** 50ms poll until a persist store reports hydration. */
/** Resolves once every write to `doc` queued so far has landed (or failed); a later write needs a later call. */
export function whenWritten(doc: string): Promise<void> {
    return (queues.get(doc) ?? Promise.resolve()).catch(() => undefined)
}

interface Hydratable {
    hasHydrated: () => boolean
    onFinishHydration: (listener: (state: unknown) => void) => () => void
}

/**
 * Resolves when a persisted store has hydrated: at once if it has, otherwise on the store's own
 * notification (a host store waits here until its document is picked and read).
 */
export function hydrated(persist: Hydratable): Promise<void> {
    if (persist.hasHydrated()) return Promise.resolve()
    return new Promise((resolve) => {
        const off = persist.onFinishHydration(() => {
            off()
            resolve()
        })
    })
}
