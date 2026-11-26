import { useEffect, useState, useSyncExternalStore } from 'react'
import { coreError } from '../../../lib/errors'
import { needsReconnect } from '../../../lib/reconnect'
import { RUNS, type Run, type Sink } from './streams'

export type JobArgs = Record<string, string | number | boolean | string[] | null | undefined>

type JobPhase = 'idle' | 'running' | 'done' | 'failed'

export interface JobState<T> {
    args: JobArgs | null
    items: T[]
    phase: JobPhase
    total: number | undefined
    progress: number | undefined
    fetchedAt: number | undefined
    error: string | undefined
    notFound: boolean
    reconnect: string | undefined
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

const BATCH_MS = 100

export class JobRunner<T> {
    private state: JobState<T> = { ...IDLE, items: [] }
    private listeners = new Set<() => void>()
    private abort: AbortController | null = null
    private serial = 0
    private again = false
    private received: T[] = []
    private unshown = false
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

    private hold() {
        if (this.state.items.length === 0 && this.unshown) this.flush()
        else this.timer ??= setTimeout(() => this.flush(), this.batchMs)
    }

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

    private drop() {
        clearTimeout(this.timer)
        this.timer = undefined
        this.unshown = false
        this.pending = null
    }

    start(args: JobArgs | null, fresh = false) {
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

    refresh = () => {
        if (this.state.args) this.start(this.state.args, true)
    }

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
                const room = Math.max(0, this.cap - this.received.length)
                for (let i = 0; i < items.length && i < room; i++) this.received.push(items[i])
                this.unshown = true
                if (this.received.length >= this.cap) {
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
