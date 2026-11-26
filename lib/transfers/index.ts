import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { transfers as api } from '../core/api'
import { coreKey } from '../core/query'
import type { Bus, Operations, Transfers } from '../core/types'
import { onLive, onResync } from '../live'
import type { OperationName } from '../operations'
import { openWindow } from '../shell'
import { type EndedFilter, EndedList } from './ended'

export async function startTransfer(
    form: Operations.Form,
    extra: { dryRun?: boolean; origin?: 'page' | 'commander'; preset?: Operations.Form } = {}
): Promise<string> {
    const started = await api.Start(form, {
        dryRun: extra.dryRun ?? false,
        origin: (extra.origin ?? 'page') as Transfers.OriginKind,
        preset: extra.preset,
    })
    return started.id
}

export async function runTemplate(id: string, tag: OperationName): Promise<string> {
    const started = await api.StartTemplate(id, tag as Operations.Operation)
    return started.id
}

const NONE: never[] = []

export function useActiveTransfers() {
    const query = useQuery({
        queryKey: coreKey('transfers', 'ListActive'),
        queryFn: () => api.ListActive(),
    })
    const transfers: Transfers.Transfer[] = query.data ?? NONE
    return { transfers, query }
}

export function useEndedTransfers(filter: EndedFilter) {
    const [list] = useState(
        () => new EndedList((ask) => api.ListEnded({ ...ask, state: ask.state as Transfers.State }))
    )
    const { state, search } = filter
    useEffect(() => {
        list.setFilter({ state, search })
    }, [list, state, search])
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const later = () => {
            if (timer !== null) clearTimeout(timer)
            timer = setTimeout(() => {
                timer = null
                list.newer()
            }, ENDED_QUIET)
        }
        const offs = [
            onLive('transfers.changed', (change) => {
                if (!['queued', 'running', 'dropped'].includes(change.state)) later()
            }),
            onResync(later),
        ]
        return () => {
            if (timer !== null) clearTimeout(timer)
            for (const off of offs) off()
        }
    }, [list])
    const snapshot = useSyncExternalStore(list.subscribe, list.snapshot)
    return { ...snapshot, list }
}

const ENDED_QUIET = 250

export function useTransfer(id: string | undefined) {
    const query = useQuery({
        queryKey: coreKey('transfers', 'Get', { id }),
        queryFn: () => api.Get(id ?? ''),
        enabled: !!id,
    })
    return { transfer: query.data, query }
}

export function useRetryable(id: string | undefined) {
    const query = useQuery({
        queryKey: coreKey('transfers', 'Retryable', { id }),
        queryFn: () => api.Retryable(id ?? ''),
        enabled: !!id,
    })
    return { retryable: query.data, query }
}

export async function retryTransfer(id: string, keys: string[][] = []): Promise<Transfers.Started> {
    return api.Retry(id, keys)
}

export async function stopTransfer(id: string): Promise<void> {
    await api.Stop(id)
}

const FILES_PAGE = 200

export function useTransferFiles(
    id: string | undefined,
    outcome: 'transferred' | 'failed' | 'checked'
) {
    const query = useInfiniteQuery({
        queryKey: coreKey('transfers', 'Files', { id, outcome }),
        enabled: !!id,
        initialPageParam: '',
        queryFn: ({ pageParam }) =>
            api.Files(id ?? '', outcome as Transfers.Outcome, pageParam, FILES_PAGE),
        getNextPageParam: (last) => (last.more ? last.items.at(-1)?.cursor : undefined),
    })
    const files = useMemo<Transfers.File[]>(
        () => query.data?.pages.flatMap((p) => p.items) ?? NONE,
        [query.data]
    )
    const total = query.data?.pages[0]?.total ?? 0
    return { files, total, query }
}

export type LiveNumbers = Readonly<Bus.TransfersProgressData['items']>

const EMPTY: LiveNumbers = {}
let live: LiveNumbers = EMPTY
const watchers = new Set<() => void>()
let unfollow: (() => void) | null = null
let said = 0

const KEPT = 50
let fresh: LiveNumbers = EMPTY
const kept = new Map<string, Bus.TransferProgress>()

export function keepLeft(
    held: Map<string, Bus.TransferProgress>,
    prev: LiveNumbers,
    next: LiveNumbers,
    max = KEPT
): LiveNumbers {
    for (const [id, numbers] of Object.entries(prev)) {
        if (numbers && !(id in next)) held.set(id, numbers)
    }
    for (const id of Object.keys(next)) held.delete(id)
    for (const id of held.keys()) {
        if (held.size <= max) break
        held.delete(id)
    }
    return held.size === 0 ? next : { ...Object.fromEntries(held), ...next }
}

function publish(next: LiveNumbers) {
    live = keepLeft(kept, fresh, next)
    fresh = next
    for (const w of watchers) w()
}

function readLive() {
    const mine = ++said
    api.Live().then(
        (items) => {
            if (mine === said && unfollow) publish(items)
        },
        (error) => console.warn('[transfers] live', error)
    )
}

function follow(): () => void {
    const offs = [
        onLive('transfers.progress', ({ items }) => {
            said += 1
            publish(items)
        }),
        onLive('transfers.changed', readLive),
        onResync(readLive),
    ]
    readLive()
    return () => {
        for (const off of offs) off()
    }
}

function subscribe(onChange: () => void) {
    watchers.add(onChange)
    unfollow ??= follow()
    return () => {
        watchers.delete(onChange)
        if (watchers.size === 0 && unfollow) {
            unfollow()
            unfollow = null
            live = EMPTY
            fresh = EMPTY
            kept.clear()
        }
    }
}

const noSubscribe = () => () => undefined

export function useLiveNumbers(enabled = true): LiveNumbers {
    return useSyncExternalStore(enabled ? subscribe : noSubscribe, () => (enabled ? live : EMPTY))
}

export function useTracked(ids: readonly string[]) {
    const query = useQuery({
        queryKey: coreKey('transfers', 'Tracked', { ids }),
        queryFn: () => api.Tracked([...ids]),
        enabled: ids.length > 0,
    })
    const items: Transfers.TrackedTransfer[] = query.data ?? NONE
    return { items, query }
}

export async function openHistory(id?: string): Promise<void> {
    await openWindow(id ? `/history?id=${encodeURIComponent(id)}` : '/history')
}
