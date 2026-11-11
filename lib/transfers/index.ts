// The transfer record, as the pages use it: starting a transfer, the lists, a transfer's details
// and files, and the live numbers of running transfers. The record is kept by the core
// (core/transfers). transfers.changed keeps the queries fresh, and transfers.progress sends the
// numbers every second.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { transfers as api } from '../core/api'
import { coreKey } from '../core/query'
import type { Bus, Operations, Transfers } from '../core/types'
import { onLive, onResync } from '../live'
import type { OperationName } from '../operations'
import { openWindow } from '../shell'
import { type EndedFilter, EndedList } from './ended'

/**
 * Starts the transfer of a form (see formOf in lib/operations) and returns its id. If the core
 * recorded the transfer before the start failed (rclone rejected it, or it ended within a
 * second), the error carries that transfer (`coreError(error)?.transfer`).
 */
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

/**
 * Runs a saved template as one of its tags, with its paths and options, and returns the
 * transfer's id. The core refuses a template without paths for the tag, and a single-source
 * operation of a template with several sources. Like startTransfer, a failed start that was
 * recorded carries its transfer.
 */
export async function runTemplate(id: string, tag: OperationName): Promise<string> {
    const started = await api.StartTemplate(id, tag as Operations.Operation)
    return started.id
}

/** An empty list that stays the same between renders. */
const NONE: never[] = []

/** The transfers that haven't ended, newest first. */
export function useActiveTransfers() {
    const query = useQuery({
        queryKey: coreKey('transfers', 'ListActive'),
        queryFn: () => api.ListActive(),
    })
    const transfers: Transfers.Transfer[] = query.data ?? NONE
    return { transfers, query }
}

/**
 * The ended transfers in one state and with a search, newest first, a page at a time (see
 * EndedList). Unlike the other queries, the list doesn't follow transfers.changed as a whole: it
 * asks only for the transfers that ended since, 250 ms after the last end or a resync. While
 * `enabled` is false, nothing is asked.
 */
export function useEndedTransfers(filter: EndedFilter, enabled = true) {
    const [list] = useState(
        () => new EndedList((ask) => api.ListEnded({ ...ask, state: ask.state as Transfers.State }))
    )
    const { state, search } = filter
    useEffect(() => {
        if (enabled) list.setFilter({ state, search })
    }, [list, state, search, enabled])
    useEffect(() => {
        if (!enabled) return
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
                // A watcher's run that changed nothing is dropped, not ended: nothing to add.
                if (!['queued', 'running', 'dropped'].includes(change.state)) later()
            }),
            onResync(later),
        ]
        return () => {
            if (timer !== null) clearTimeout(timer)
            for (const off of offs) off()
        }
    }, [list, enabled])
    const snapshot = useSyncExternalStore(list.subscribe, list.snapshot)
    return { ...snapshot, list }
}

/** How long the ended list waits after the last end before it asks for the newer rows, in ms. */
const ENDED_QUIET = 250

/** One transfer, with its retries, its preset, and the errors that aren't tied to a file. */
export function useTransfer(id: string | undefined) {
    const query = useQuery({
        queryKey: coreKey('transfers', 'Get', { id }),
        queryFn: () => api.Get(id ?? ''),
        enabled: !!id,
    })
    return { transfer: query.data, query }
}

/**
 * What can be retried from an ended transfer, and the errors that aren't tied to a file.
 * `refused` explains why this build can't start a retry, and is shown instead of Retry. It is ""
 * when a retry can start.
 */
export function useRetryable(id: string | undefined) {
    const query = useQuery({
        queryKey: coreKey('transfers', 'Retryable', { id }),
        queryFn: () => api.Retryable(id ?? ''),
        enabled: !!id,
    })
    return { retryable: query.data, query }
}

/**
 * Retries some of an ended transfer's failures, or all of them when `keys` is empty. Returns the
 * new transfer's id and number.
 */
export async function retryTransfer(id: string, keys: string[][] = []): Promise<Transfers.Started> {
    return api.Retry(id, keys)
}

export async function stopTransfer(id: string): Promise<void> {
    await api.Stop(id)
}

const FILES_PAGE = 200

/** A transfer's files with one outcome, newest first, a page at a time. */
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

/** The numbers of each running transfer for the last second, by id. */
export type LiveNumbers = Readonly<Bus.TransfersProgressData['items']>

const EMPTY: LiveNumbers = {}
let live: LiveNumbers = EMPTY
const watchers = new Set<() => void>()
let unfollow: (() => void) | null = null
/**
 * Counts the updates to the numbers (each event and each read), so that an older result never
 * replaces a newer one.
 */
let said = 0

function publish(next: LiveNumbers) {
    live = next
    for (const w of watchers) w()
}

/**
 * Reads the numbers now. If an event arrives while the read is running, the event is newer, so
 * the read's result is dropped.
 */
function readLive() {
    const mine = ++said
    api.Live().then(
        (items) => {
            if (mine === said && unfollow) publish(items)
        },
        (error) => console.warn('[transfers] live', error)
    )
}

/**
 * Follows the numbers while anything shows them. It reads the current numbers, then takes
 * transfers.progress every second. The numbers are read again on transfers.changed, which is sent
 * when a transfer ends, and on core.resync, which is sent after missed events.
 */
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
        }
    }
}

/** A store that never changes, so that a component that doesn't show the numbers follows none. */
const noSubscribe = () => () => undefined

/**
 * The live numbers of running transfers, followed while the component shows them. When
 * `enabled` is false, nothing is followed or read.
 */
export function useLiveNumbers(enabled = true): LiveNumbers {
    return useSyncExternalStore(enabled ? subscribe : noSubscribe, () => (enabled ? live : EMPTY))
}

/**
 * What became of the transfers that a page started, newest last. transfers.changed refetches
 * them.
 */
export function useTracked(ids: readonly string[]) {
    const query = useQuery({
        queryKey: coreKey('transfers', 'Tracked', { ids }),
        queryFn: () => api.Tracked([...ids]),
        enabled: ids.length > 0,
    })
    const items: Transfers.TrackedTransfer[] = query.data ?? NONE
    return { items, query }
}

/** Opens the History window on one transfer's details, or on the list. */
export async function openHistory(id?: string): Promise<void> {
    await openWindow(id ? `/history?id=${encodeURIComponent(id)}` : '/history')
}
