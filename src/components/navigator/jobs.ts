// Tracks the slow or large reads behind the panels: listings, search, folder sizes and compare.
// The core sends the items as it finds them (streams.ts). They are collected here in a small
// store that components read with useSyncExternalStore. Aborting a run cancels the core's call.
// The items are the core's own types (`Browse.Row`, `Browse.FolderSize`, `Browse.Pair`), and a
// row's path is complete and ready to use.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { coreError } from '../../../lib/errors'
import { needsReconnect } from '../../../lib/reconnect'
import { RUNS, type Run, type Sink } from './streams'

export type JobArgs = Record<string, string | number | boolean | string[] | null | undefined>

type JobPhase = 'idle' | 'running' | 'done' | 'failed'

export interface JobState<T> {
    /** The arguments that `items` belong to, or `null` when nothing was requested. */
    args: JobArgs | null
    items: T[]
    phase: JobPhase
    /** How many items the job holds so far. */
    total: number | undefined
    progress: number | undefined
    fetchedAt: number | undefined
    error: string | undefined
    /** The job failed because the folder or file it reads doesn't exist (the core's `not_found`). */
    notFound: boolean
    /** The remote whose sign-in expired, when that is why the job failed. */
    reconnect: string | undefined
    /** The cap was reached, so `items` is incomplete. */
    capped: boolean
}

const IDLE: JobState<never> = {
    args: null,
    items: [],
    phase: 'idle',
    total: undefined,
    progress: undefined,
    fetchedAt: undefined,
    error: undefined,
    notFound: false,
    reconnect: undefined,
    capped: false,
}

function sameArgs(a: JobArgs | null, b: JobArgs | null): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * How often (in ms) a running job shows the items that arrived since the last update. A large
 * folder arrives in many pieces, and showing each one rebuilds and sorts all of the panel's rows.
 * So the pieces that arrive in between are held and shown together. The first piece is shown
 * immediately, and so is the end.
 */
const BATCH_MS = 100

export class JobRunner<T> {
    private state: JobState<T> = { ...IDLE, items: [] }
    private listeners = new Set<() => void>()
    private abort: AbortController | null = null
    private serial = 0
    private again = false
    /** Everything the running job has received, shown or not (`state.items` is a copy). */
    private received: T[] = []
    /** Whether `received` holds items not shown yet. */
    private unshown = false
    /** Progress not shown yet. */
    private pending: Partial<JobState<T>> | null = null
    private timer: ReturnType<typeof setTimeout> | undefined

    private readonly run: Run<T>
    private readonly cap: number
    private readonly batchMs: number

    constructor(run: Run<T>, cap = Number.POSITIVE_INFINITY, batchMs = BATCH_MS) {
        this.run = run
        this.cap = cap
        this.batchMs = batchMs
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    snapshot = () => this.state

    private set(patch: Partial<JobState<T>>) {
        this.state = { ...this.state, ...patch }
        for (const l of this.listeners) l()
    }

    /** Shows new items with the next batch. The first items are shown immediately. */
    private hold() {
        if (this.state.items.length === 0 && this.unshown) this.flush()
        else this.timer ??= setTimeout(() => this.flush(), this.batchMs)
    }

    /** Shows what is held, applying `patch` (an end or a failure) in the same update. */
    private flush(patch: Partial<JobState<T>> = {}) {
        const held: Partial<JobState<T>> = { ...this.pending }
        if (this.unshown) {
            held.items = this.received.slice()
            held.total = this.received.length
        }
        this.drop()
        const change = { ...held, ...patch }
        if (Object.keys(change).length > 0) this.set(change)
    }

    /** Clears what is held, after it is shown or when the job is stopped. */
    private drop() {
        clearTimeout(this.timer)
        this.timer = undefined
        this.unshown = false
        this.pending = null
    }

    /** Cancels the old run and starts one for `args`. `null` means there is nothing to read. */
    start(args: JobArgs | null, fresh = false) {
        // The same arguments keep their result, or their run while it is still going. A run that
        // was stopped before it ended (by an unmount) is started again.
        const settled =
            this.state.phase === 'done' ||
            this.state.phase === 'failed' ||
            (this.state.phase === 'running' && this.abort !== null)
        if (!fresh && sameArgs(args, this.state.args) && settled) return
        if (!fresh && args === null && this.state.args === null) return
        this.stop()
        this.again = false
        this.received = []
        this.set({ ...IDLE, items: [], args, phase: args ? 'running' : 'idle' })
        if (args) this.go(args, fresh)
    }

    /** Reads from rclone again, bypassing the core's cache. */
    refresh = () => {
        if (this.state.args) this.start(this.state.args, true)
    }

    /**
     * Reads the same arguments from the core again, which may have a newer result after a change
     * made by the page or a transfer that ended. A job that is still running is allowed to
     * finish, and then runs again.
     */
    reask = () => {
        const args = this.state.args
        if (!args) return
        if (this.state.phase === 'running') {
            this.again = true
            return
        }
        this.set({ args: null })
        this.start(args)
    }

    /** Cancels the run, for example on unmount or new arguments. */
    stop() {
        this.serial += 1
        this.abort?.abort()
        this.abort = null
        this.drop()
    }

    private go(args: JobArgs, fresh: boolean) {
        const serial = ++this.serial
        const abort = new AbortController()
        this.abort = abort
        const mine = () => serial === this.serial
        const sink: Sink<T> = {
            add: (items) => {
                if (!mine()) return
                // Append in place. The new items are shown with the next batch.
                const room = Math.max(0, this.cap - this.received.length)
                for (let i = 0; i < items.length && i < room; i++) this.received.push(items[i])
                this.unshown = true
                if (this.received.length >= this.cap) {
                    // Show the items before cancelling the run, because cancelling clears
                    // what is held.
                    this.flush({ phase: 'done', capped: true })
                    this.stop()
                    this.over()
                    return
                }
                this.hold()
            },
            progress: (n) => {
                if (!mine()) return
                this.pending = { ...this.pending, progress: n }
                this.hold()
            },
            end: ({ fetchedAt, capped }) => {
                if (!mine()) return
                this.flush({ phase: 'done', fetchedAt, capped: !!capped || this.state.capped })
            },
        }
        this.run(args, fresh, abort.signal, sink)
            .then(() => {
                if (mine() && this.state.phase === 'running') this.flush({ phase: 'done' })
            })
            .catch((error: unknown) => {
                if (!mine() || abort.signal.aborted) return
                const e = coreError(error)
                const message =
                    e?.message ?? (error instanceof Error ? error.message : String(error))
                this.flush({
                    phase: 'failed',
                    error: message,
                    notFound: e?.code === 'not_found',
                    reconnect: needsReconnect(error) ?? undefined,
                })
            })
            .finally(() => {
                if (mine()) this.over()
            })
    }

    private over() {
        if (!this.again) return
        this.again = false
        this.reask()
    }
}

/**
 * Runs the job `kind` with `args`, which is `null` while there is nothing to read. New `args`
 * cancel the old run and start a new one, and unmounting cancels it too. `cap` is the
 * component's item limit (50 000 for a listing, 5 000 for a search, 20 000 for a compare).
 * `fresh` reads from rclone instead of the core's cache each time the arguments change.
 */
export function useJob<T>(
    kind: 'list' | 'search' | 'sizes' | 'compare',
    args: JobArgs | null,
    options: { cap?: number; fresh?: boolean } = {}
) {
    const [job] = useState(() => new JobRunner<T>(RUNS[kind] as Run<T>, options.cap))
    const argsKey = args ? JSON.stringify(args) : ''
    const fresh = !!options.fresh
    useEffect(() => {
        job.start(argsKey ? (JSON.parse(argsKey) as JobArgs) : null, fresh && !!argsKey)
        return () => job.stop()
    }, [job, argsKey, fresh])
    const state = useSyncExternalStore(job.subscribe, job.snapshot)
    return { ...state, refresh: job.refresh, reask: job.reask }
}
