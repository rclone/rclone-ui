import { describe, expect, it, test } from 'vitest'
import searchCases from '../../testdata/transfer_search_cases.json'
import type { Transfers } from '../core/types'
import {
    ENDED_CAP,
    ENDED_PAGE,
    type EndedAsk,
    EndedList,
    latestEnd,
    matches,
    mergeRows,
} from './ended'

const row = (n: number, endedAt = 1000 + n, extra: Partial<Transfers.Transfer> = {}) =>
    ({
        id: `${n}-x`,
        seq: n,
        createdAt: n,
        startedAt: n,
        endedAt,
        state: 'completed',
        operation: 'copy',
        sources: ['/a'],
        destination: 'gdrive:b',
        isDryRun: false,
        origin: { kind: 'page' },
        error: '',
        stats: null,
        live: null,
        ...extra,
    }) as Transfers.Transfer

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A core that answers from `rows`, as transfers.ListEnded does, and records what it was asked. */
function core(rows: Transfers.Transfer[]) {
    const asked: EndedAsk[] = []
    const fetch = async (ask: EndedAsk) => {
        asked.push(ask)
        let found = [...rows].sort((a, b) => b.createdAt - a.createdAt)
        if (ask.state) found = found.filter((t) => t.state === ask.state)
        found = found.filter((t) => matches(t, ask.search))
        if (ask.after) {
            found = found
                .filter((t) => (t.endedAt ?? 0) >= ask.after)
                .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
        } else if (ask.before) {
            const at = found.findIndex((t) => t.id === ask.before)
            found = found.slice(at + 1)
        }
        const page = found.slice(0, ask.limit)
        return { items: page, more: found.length > ask.limit }
    }
    return { asked, fetch }
}

describe('matches', () => {
    // The same table is read by core/transfers' TestMatches, so the page's filter and the core's
    // search find the same transfers.
    const { transfer, searches } = searchCases as {
        transfer: Partial<Transfers.Transfer>
        searches: { search: string; matches: boolean }[]
    }
    const t = row(transfer.seq ?? 0, 0, transfer)
    it.each(searches)('$search: $matches', ({ search, matches: want }) => {
        expect(matches(t, search)).toBe(want)
    })
})

describe('mergeRows', () => {
    it('keeps each transfer once, newest first, and cuts at the cap', () => {
        const held = [row(3), row(2), row(1)]
        const { items, cut } = mergeRows(
            held,
            [row(2, 5, { state: 'failed' as Transfers.State }), row(4)],
            3
        )
        expect(items.map((t) => t.seq)).toEqual([4, 3, 2])
        expect(items[2].state).toBe('failed')
        expect(cut).toBe(true)
    })
})

describe('latestEnd', () => {
    it('is the latest end, not the newest row', () => {
        expect(latestEnd([row(3, 10), row(2, 50), row(1, 20)])).toBe(50)
        expect(latestEnd([])).toBe(0)
    })
})

describe('EndedList', () => {
    it('loads pages of 200 and holds at most 5,000 rows', async () => {
        expect(ENDED_PAGE).toBe(200)
        expect(ENDED_CAP).toBe(5000)
        const rows = Array.from({ length: 5300 }, (_, i) => row(i + 1))
        const { fetch, asked } = core(rows)
        const list = new EndedList(fetch)
        list.setFilter({ state: '', search: '' })
        await flush()
        expect(list.snapshot().items).toHaveLength(200)
        expect(asked[0]).toMatchObject({ limit: 200, before: '', after: 0 })
        for (let i = 0; i < 40; i++) {
            list.older()
            await flush()
        }
        const state = list.snapshot()
        expect(state.items).toHaveLength(5000)
        expect(state.hasOlder).toBe(false)
        expect(asked.length).toBe(25)
        expect(asked[1].before).toBe(rows[5299 - 199].id)
    })

    it('asks only for the rows that ended since, and keeps the filter', async () => {
        const rows = [row(1), row(2), row(3, 1003, { state: 'failed' as Transfers.State })]
        const { fetch, asked } = core(rows)
        const list = new EndedList(fetch)
        list.setFilter({ state: 'completed', search: '' })
        await flush()
        expect(list.snapshot().items.map((t) => t.seq)).toEqual([2, 1])
        rows.push(row(4), row(5, 1005, { state: 'failed' as Transfers.State }))
        list.newer()
        await flush()
        expect(asked[1]).toMatchObject({ state: 'completed', after: 1002 })
        expect(list.snapshot().items.map((t) => t.seq)).toEqual([4, 2, 1])
    })

    it('follows a newer page that stopped at its limit with the next one', async () => {
        const rows = [row(1)]
        const { fetch, asked } = core(rows)
        const list = new EndedList(fetch, 100, 2)
        list.setFilter({ state: '', search: '' })
        await flush()
        rows.push(row(2), row(3), row(4), row(5))
        list.newer()
        for (let i = 0; i < 5; i++) await flush()
        expect(list.snapshot().items.map((t) => t.seq)).toEqual([5, 4, 3, 2, 1])
        // The end it asks after is shown again, so each page of 2 brings one more.
        expect(asked.map((a) => a.after)).toEqual([0, 1001, 1002, 1003, 1004])
        expect(list.snapshot().loading).toBe(false)
    })

    it('stops following when the ends stay in the same millisecond', async () => {
        const rows = [row(1)]
        const { fetch, asked } = core(rows)
        const list = new EndedList(fetch, 100, 2)
        list.setFilter({ state: '', search: '' })
        await flush()
        rows.push(row(2, 1001), row(3, 1001), row(4, 1001))
        list.newer()
        for (let i = 0; i < 5; i++) await flush()
        expect(asked.length).toBe(2)
        expect(list.snapshot().loading).toBe(false)
    })

    it('asks for a newer page again when one is asked for while another is on its way', async () => {
        const rows = [row(1)]
        const { fetch, asked } = core(rows)
        const list = new EndedList(fetch)
        list.setFilter({ state: '', search: '' })
        list.newer()
        list.newer()
        await flush()
        await flush()
        expect(asked.map((a) => a.after)).toEqual([0, 1001])
    })

    it('drops the answer for a filter that changed', async () => {
        const rows = [row(1, 1001, { destination: 'gdrive:photos' }), row(2)]
        const { fetch } = core(rows)
        const list = new EndedList(fetch)
        list.setFilter({ state: '', search: '' })
        list.setFilter({ state: '', search: 'photos' })
        await flush()
        expect(list.snapshot().items.map((t) => t.seq)).toEqual([1])
    })

    it('keeps its rows while a refresh is on its way, then shows only the newest page', async () => {
        const rows = Array.from({ length: 450 }, (_, i) => row(i + 1))
        const { fetch } = core(rows)
        const list = new EndedList(fetch)
        list.setFilter({ state: '', search: '' })
        await flush()
        list.older()
        await flush()
        expect(list.snapshot().items).toHaveLength(400)
        list.refresh()
        expect(list.snapshot().items).toHaveLength(400)
        await flush()
        expect(list.snapshot().items).toHaveLength(200)
        expect(list.snapshot().hasOlder).toBe(true)
    })

    it('reports a failure, and retries what failed', async () => {
        let fail = true
        const list = new EndedList(async () => {
            if (fail) throw new Error('core down')
            return { items: [row(1)], more: false }
        })
        list.setFilter({ state: '', search: '' })
        await flush()
        expect(list.snapshot()).toMatchObject({ settled: true, loading: false })
        expect(String(list.snapshot().error)).toContain('core down')
        fail = false
        list.retry()
        await flush()
        expect(list.snapshot()).toMatchObject({ error: null, items: [row(1)] })
    })
})

test('a transfer is found by its operation as History names it', () => {
    const transfer = {
        ...searchCases.transfer,
        operation: 'delete-folder',
    } as unknown as Transfers.Transfer
    expect(matches(transfer, 'eliminar carpeta', 'Eliminar carpeta')).toBe(true)
    expect(matches(transfer, 'delete-folder', 'Eliminar carpeta')).toBe(true)
    expect(matches(transfer, 'eliminar carpeta')).toBe(false)
})
