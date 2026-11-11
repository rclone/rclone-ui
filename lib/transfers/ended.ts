// The ended transfers that History lists, a page at a time. The list asks the core for the newest
// page, then for older pages as the user scrolls, and for newer rows only after a transfer ends.
// It holds at most ENDED_CAP rows. Pure: the core is reached through the `fetch` it is given.

import type { Transfers } from '../core/types'

type Transfer = Transfers.Transfer

/** Rows per page. The core answers at most 200. */
export const ENDED_PAGE = 200
/** The most rows the list holds. */
export const ENDED_CAP = 5000

/** The ends that History can narrow the list to. "" is every end. */
export type EndedState = '' | 'completed' | 'failed' | 'stopped'

/** What the list shows: the ended transfers in one state, with a search. */
export interface EndedFilter {
    state: EndedState
    search: string
}

/** One question to the core (transfers.ListEnded). */
export interface EndedAsk extends EndedFilter {
    before: string
    after: number
    limit: number
}

export type EndedFetch = (ask: EndedAsk) => Promise<{ items: Transfer[]; more: boolean }>

export interface EndedSnapshot {
    items: Transfer[]
    /** Whether older rows can be loaded. */
    hasOlder: boolean
    loading: boolean
    /** Whether the first page has been answered (or has failed) since the filter last changed. */
    settled: boolean
    error: unknown
    /** Whether the error came from loading older rows, so that Retry asks for them again. */
    olderFailed: boolean
    /** When the list last had an answer, in ms. */
    updatedAt: number
}

/** Sorts by creation time, newest first, which is the order of the core's pages. */
export const newestFirst = (a: Transfer, b: Transfer) =>
    b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/**
 * Whether `search` is in a transfer's number (#12), operation, paths, error or origin's name,
 * ignoring case. The operation matches by its key ("sync") and by `name`, its name as History
 * shows it in the app's language ("Sincronizar").
 *
 * The page filters the running transfers with it, and it finds what the core's search finds
 * (transfers.Matches, with transfers.OperationName). The page can't ask the core instead,
 * because the core's pages don't yet have the rows that are still leaving the running list.
 * `testdata/transfer_search_cases.json` holds the cases that both sides are tested against.
 */
export function matches(
    transfer: Pick<Transfer, 'seq' | 'operation' | 'destination' | 'error' | 'sources' | 'origin'>,
    search: string,
    name = ''
): boolean {
    const needle = search.trim().toLowerCase()
    if (!needle) return true
    return [
        `#${transfer.seq}`,
        transfer.operation,
        name,
        transfer.destination ?? '',
        transfer.error ?? '',
        transfer.origin?.name ?? '',
        ...transfer.sources,
    ].some((text) => text.toLowerCase().includes(needle))
}

/**
 * The latest end among the rows, or 0 when there is none. The list asks the core for the rows
 * that ended since then.
 */
export function latestEnd(items: readonly Transfer[]): number {
    let latest = 0
    for (const item of items) if ((item.endedAt ?? 0) > latest) latest = item.endedAt ?? 0
    return latest
}

/**
 * Adds rows to the list: the newest first, each transfer once (the new row replaces the old one),
 * and at most `cap` of them. Returns the rows and whether some were cut off the end.
 */
export function mergeRows(
    held: readonly Transfer[],
    fresh: readonly Transfer[],
    cap = ENDED_CAP
): { items: Transfer[]; cut: boolean } {
    const byId = new Map<string, Transfer>()
    for (const item of held) byId.set(item.id, item)
    for (const item of fresh) byId.set(item.id, item)
    const all = [...byId.values()].sort(newestFirst)
    return { items: all.slice(0, cap), cut: all.length > cap }
}

const INITIAL: EndedSnapshot = {
    items: [],
    hasOlder: false,
    loading: false,
    settled: false,
    error: null,
    olderFailed: false,
    updatedAt: 0,
}

type Direction = 'first' | 'older' | 'newer'

/**
 * The ended list. Only one question is on its way at a time, and the others wait for it. A newer
 * page asked for while one is on its way is asked for again after it, because the end that asked
 * for it may have come after the question. A change of filter drops whatever is on its way.
 */
export class EndedList {
    private state: EndedSnapshot = INITIAL
    private filter: EndedFilter = { state: '', search: '' }
    private readonly watchers = new Set<() => void>()
    private inFlight: Direction | null = null
    private queue: Direction[] = []
    /** Counts the filter changes, so that an answer for an older filter is dropped. */
    private generation = 0

    constructor(
        private readonly fetch: EndedFetch,
        private readonly cap = ENDED_CAP,
        private readonly limit = ENDED_PAGE
    ) {}

    subscribe = (watcher: () => void) => {
        this.watchers.add(watcher)
        return () => {
            this.watchers.delete(watcher)
        }
    }

    snapshot = () => this.state

    /** Shows the transfers that match `filter`, from the newest page. */
    setFilter(filter: EndedFilter) {
        this.filter = filter
        this.first()
    }

    /** Loads the newest page again, and drops the rest at once. */
    first = () => {
        this.generation += 1
        this.inFlight = null
        this.queue = []
        this.set({ ...INITIAL, updatedAt: this.state.updatedAt })
        this.request('first')
    }

    /** Loads the newest page again. The rows stay until it answers, and then it replaces them. */
    refresh = () => {
        this.generation += 1
        this.inFlight = null
        this.queue = []
        return this.request('first')
    }

    /** Loads the next older page, unless one is on its way or there is none. */
    older = () => {
        if (!this.state.hasOlder || this.inFlight === 'older') return
        this.want('older')
    }

    /** Loads the transfers that ended since the latest one shown. */
    newer = () => this.want(this.state.items.length === 0 ? 'first' : 'newer')

    /** Asks again for what failed. */
    retry = () => (this.state.olderFailed ? this.older() : this.first())

    private want(direction: Direction) {
        if (this.inFlight !== null) {
            if (!this.queue.includes(direction)) this.queue.push(direction)
            return
        }
        this.request(direction)
    }

    private set(next: Partial<EndedSnapshot>) {
        this.state = { ...this.state, ...next }
        for (const watcher of this.watchers) watcher()
    }

    private async request(direction: Direction) {
        const generation = this.generation
        const { items } = this.state
        const ask: EndedAsk = {
            ...this.filter,
            before: direction === 'older' ? (items.at(-1)?.id ?? '') : '',
            after: direction === 'newer' ? latestEnd(items) : 0,
            limit: this.limit,
        }
        this.inFlight = direction
        this.set({ loading: true })
        let more = false
        try {
            const page = await this.fetch(ask)
            if (generation !== this.generation) return
            this.take(direction, page.items, page.more)
            // Follow only a page that moved the latest end on, so that many ends in the same
            // millisecond can't keep asking for the same page.
            more = page.more && latestEnd(this.state.items) > ask.after
        } catch (error) {
            if (generation !== this.generation) return
            this.set({ error, olderFailed: direction === 'older', settled: true })
        } finally {
            if (generation === this.generation) {
                this.inFlight = null
                // A newer page that stopped at its limit is followed by the next one.
                if (direction === 'newer' && more && !this.queue.includes('newer')) {
                    this.queue.push('newer')
                }
                const next = this.queue.shift()
                if (next === 'older') this.older()
                else if (next) this.newer()
                if (this.inFlight === null) this.set({ loading: false })
            }
        }
    }

    private take(direction: Direction, fresh: Transfer[], more: boolean) {
        const held = this.state
        const answered = { error: null, olderFailed: false, settled: true, updatedAt: Date.now() }
        if (direction === 'first') {
            const items = fresh.slice(0, this.cap)
            this.set({ ...answered, items, hasOlder: more || fresh.length > this.cap })
            return
        }
        const { items, cut } = mergeRows(held.items, fresh, this.cap)
        if (direction === 'older') {
            // At the cap, older rows are no longer loaded.
            this.set({ ...answered, items, hasOlder: more && !cut && items.length < this.cap })
            return
        }
        this.set({ ...answered, items, hasOlder: held.hasOlder || cut })
    }
}
