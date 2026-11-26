import type { CancellablePromise } from '@wailsio/runtime'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { browse } from '../../../lib/core/api'
import type { Browse } from '../../../lib/core/types'
import { coreError, formatErrorMessage } from '../../../lib/errors'
import { onLive } from '../../../lib/live'
import { needsReconnect } from '../../../lib/reconnect'
import type { UsageSort } from './usage'

export type UsagePhase = 'idle' | 'opening' | 'scanning' | 'ended' | 'failed' | 'gone'

export interface UsageScan {
    phase: UsagePhase
    request?: string
    from?: string
    progress?: Browse.UsageProgress
    error?: string
    reconnect?: string
    version: number
}

const IDLE: UsageScan = { phase: 'idle', version: 0 }

export class DiskUsage {
    private state: UsageScan = IDLE
    private listeners = new Set<() => void>()
    private call: CancellablePromise<void> | null = null

    subscribe = (listener: () => void) => {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    snapshot = () => this.state

    private set(next: UsageScan) {
        this.state = next
        for (const listener of this.listeners) listener()
    }

    private update(request: string, change: (s: UsageScan) => UsageScan) {
        if (this.state.request === request) this.set(change(this.state))
    }

    attach = () => {
        const off = onLive('browse:usage', (progress) =>
            this.update(progress.request, (s) => ({
                ...s,
                progress,
                phase: progress.state === 'scanning' ? 'scanning' : 'ended',
            }))
        )
        return () => {
            off()
            this.call?.cancel()
            this.call = null
        }
    }

    private begin(from: string) {
        this.call?.cancel()
        const request = crypto.randomUUID()
        this.set({ phase: 'opening', request, from, version: 0 })
        const running = browse.Usage(request, from)
        this.call = running
        running.then(
            () => this.update(request, (s) => ({ ...s, phase: 'gone' })),
            (error: unknown) => {
                if (this.call !== running) return
                this.update(request, (s) => ({
                    ...s,
                    phase: 'failed',
                    error: formatErrorMessage(error),
                    reconnect: needsReconnect(error) ?? undefined,
                }))
            }
        )
    }

    open = async (from: string) => {
        const s = this.state
        const live = s.phase === 'opening' || s.phase === 'scanning' || s.phase === 'ended'
        if (live && s.from === from) return
        if (live && s.progress) {
            try {
                const root = await browse.UsageRoot(from)
                if (root === s.progress.root && this.state.request === s.request) return
            } catch {}
        }
        this.begin(from)
    }

    rescan = () => {
        if (this.state.from) this.begin(this.state.from)
    }

    stop = () => {
        const request = this.state.request
        if (request) browse.UsageStop(request).catch(() => undefined)
    }

    forget = async (rel: string, isDir: boolean) => {
        const request = this.state.request
        if (!request) return
        try {
            await browse.UsageForget(request, rel, isDir)
        } catch {
            return
        }
        this.update(request, (s) => ({ ...s, version: s.version + 1 }))
    }

    lost = (request: string) => {
        this.update(request, (s) => ({ ...s, phase: 'gone' }))
    }
}

export function useDiskUsage() {
    const [usage] = useState(() => new DiskUsage())
    useEffect(() => usage.attach(), [usage])
    const scan = useSyncExternalStore(usage.subscribe, usage.snapshot)
    return {
        scan,
        open: usage.open,
        rescan: usage.rescan,
        stop: usage.stop,
        forget: usage.forget,
        lost: usage.lost,
    }
}

export const USAGE_BEAT = 500

export interface ShownLevel {
    rel: string
    by: UsageSort
    level: Browse.UsageLevel
}

export function useUsageLevel(
    scan: UsageScan,
    rel: string,
    by: UsageSort,
    limit: number,
    onMissing: () => void,
    onLost: (request: string) => void
): ShownLevel | null {
    const [shown, setShown] = useState<ShownLevel | null>(null)
    const { request, phase, version } = scan
    const running = phase === 'opening' || phase === 'scanning'
    const readable = running || phase === 'ended'
    const handlers = useRef({ onMissing, onLost })
    handlers.current = { onMissing, onLost }

    // biome-ignore lint/correctness/useExhaustiveDependencies: `version` reads the folder again after an entry was taken out of the scan
    useEffect(() => {
        if (!request || !readable) return
        let alive = true
        let timer: ReturnType<typeof setTimeout> | undefined
        const read = async () => {
            try {
                const level = await browse.UsageLevel(request, rel, by as Browse.UsageSort, limit)
                if (alive) setShown({ rel, by, level })
            } catch (error) {
                const e = coreError(error)
                if (alive && e?.code === 'not_found') {
                    if (e.what === 'scan') handlers.current.onLost(request)
                    else handlers.current.onMissing()
                    return
                }
            }
            if (alive && running) timer = setTimeout(read, USAGE_BEAT)
        }
        read()
        return () => {
            alive = false
            clearTimeout(timer)
        }
    }, [request, readable, running, rel, by, limit, version])

    return shown
}
