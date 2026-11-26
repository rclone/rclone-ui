import type { Transfers } from '../core/types'

type Transfer = Transfers.Transfer

export const ENDED_PAGE = 200
export const ENDED_CAP = 5000

export type EndedState = '' | 'completed' | 'failed' | 'stopped'

export interface EndedFilter {
    state: EndedState
    search: string
}

export interface EndedAsk extends EndedFilter {
    before: string
    after: number
    limit: number
}

export type EndedFetch = (ask: EndedAsk) => Promise<{ items: Transfer[]; more: boolean }>

export interface EndedSnapshot {
    items: Transfer[]
    hasOlder: boolean
    loading: boolean
    settled: boolean
    error: unknown
    olderFailed: boolean
    askedAt: number
}

export const newestFirst = (a: Transfer, b: Transfer) =>
    b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

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

export function latestEnd(items: readonly Transfer[]): number {
    let latest = 0
    for (const item of items) if ((item.endedAt ?? 0) > latest) latest = item.endedAt ?? 0
    return latest
}

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
    askedAt: 0,
}

type Direction = 'first' | 'older' | 'newer'

export class EndedList {
    private state: EndedSnapshot = INITIAL
    private filter: EndedFilter = { state: '', search: '' }
    private readonly watchers = new Set<() => void>()
    private inFlight: Direction | null = null
    private queue: Direction[] = []
    private generation = 0
    private cursor = ''

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

    setFilter(filter: EndedFilter) {
        this.filter = filter
        this.first()
    }

    first = () => {
        this.generation += 1
        this.inFlight = null
        this.queue = []
        this.set({ ...INITIAL, askedAt: this.state.askedAt })
        this.request('first')
    }

    refresh = () => {
        this.generation += 1
        this.inFlight = null
        this.queue = []
        return this.request('first')
    }

    older = () => {
        if (!this.state.hasOlder || this.inFlight === 'older') return
        this.want('older')
    }

    newer = () => this.want(this.state.items.length === 0 ? 'first' : 'newer')

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
            before: direction === 'older' ? this.cursor : '',
            after: direction === 'newer' ? latestEnd(items) : 0,
            limit: this.limit,
        }
        this.inFlight = direction
        const askedAt = Date.now()
        this.set({ loading: true })
        let more = false
        try {
            const page = await this.fetch(ask)
            if (generation !== this.generation) return
            this.take(direction, page.items, page.more, askedAt)
            more = page.more && latestEnd(this.state.items) > ask.after
        } catch (error) {
            if (generation !== this.generation) return
            this.set({ error, olderFailed: direction === 'older', settled: true })
        } finally {
            if (generation === this.generation) {
                this.inFlight = null
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

    private take(direction: Direction, fresh: Transfer[], more: boolean, askedAt: number) {
        const held = this.state
        const answered = { error: null, olderFailed: false, settled: true, askedAt }
        if (direction === 'first') {
            const items = fresh.slice(0, this.cap)
            this.cursor = items.at(-1)?.id ?? ''
            this.set({ ...answered, items, hasOlder: more || fresh.length > this.cap })
            return
        }
        const { items, cut } = mergeRows(held.items, fresh, this.cap)
        if (direction === 'older') {
            this.cursor = fresh.at(-1)?.id ?? this.cursor
            this.set({ ...answered, items, hasOlder: more && !cut && items.length < this.cap })
            return
        }
        this.set({ ...answered, items, hasOlder: held.hasOlder || cut })
    }
}
