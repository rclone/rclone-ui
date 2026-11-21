// The Disk Usage scan that the Commander holds (`DiskUsageDrawer`). The scan is one long call to
// the core (browse.Usage). It sends its progress as `browse:usage` events while it runs, and then
// keeps its result until the call is cancelled. So the page keeps the call while the window is
// open, and the drawer shows the same scan each time it opens on the same remote or disk. Opening
// it on another one cancels the call, which frees the scan, and starts a new one.

import type { CancellablePromise } from '@wailsio/runtime'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { browse } from '../../../lib/core/api'
import type { Browse } from '../../../lib/core/types'
import { coreError, formatErrorMessage } from '../../../lib/errors'
import { onLive } from '../../../lib/live'
import { needsReconnect } from '../../../lib/reconnect'
import type { UsageSort } from './usage'

/**
 * Where the scan is. `opening` waits for its first progress. `failed` found nothing at all,
 * because the remote didn't open or its root couldn't be listed. `gone` is a scan that the core
 * let go of, after a long time unread.
 */
export type UsagePhase = 'idle' | 'opening' | 'scanning' | 'ended' | 'failed' | 'gone'

export interface UsageScan {
    phase: UsagePhase
    request?: string
    /** The folder that the scan was asked from. Scanning again starts from it. */
    from?: string
    progress?: Browse.UsageProgress
    error?: string
    /** The remote whose sign-in expired, when that is why the scan failed. */
    reconnect?: string
    /** Changes when an entry is taken out of the scan, so the folder shown is read again. */
    version: number
}

const IDLE: UsageScan = { phase: 'idle', version: 0 }

/**
 * The scan that a page holds, as a small store that components read with useSyncExternalStore.
 * It follows the scan's events while it is attached, which is while the page is mounted.
 */
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

    /** Changes the state only while it still belongs to request. */
    private update(request: string, change: (s: UsageScan) => UsageScan) {
        if (this.state.request === request) this.set(change(this.state))
    }

    /**
     * Follows the scan's progress, and returns a function that stops following it and lets go of
     * the scan. A page attaches when it mounts and detaches when it goes away.
     */
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
            // The core let go of the scan: it went unread too long, or another scan replaced it.
            () => this.update(request, (s) => ({ ...s, phase: 'gone' })),
            (error: unknown) => {
                // A cancelled call belongs to a scan that is no longer the page's.
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

    /**
     * Shows the scan of the remote or disk that the folder at `from` is on. The scan the page
     * holds is shown again when it covers that folder, and a new one starts otherwise.
     */
    open = async (from: string) => {
        const s = this.state
        const live = s.phase === 'opening' || s.phase === 'scanning' || s.phase === 'ended'
        if (live && s.from === from) return
        if (live && s.progress) {
            try {
                const root = await browse.UsageRoot(from)
                if (root === s.progress.root && this.state.request === s.request) return
            } catch {
                // The scan reports why the folder can't be scanned.
            }
        }
        this.begin(from)
    }

    rescan = () => {
        if (this.state.from) this.begin(this.state.from)
    }

    /** Stops the scan's walk. The scan keeps what it found. */
    stop = () => {
        const request = this.state.request
        if (request) browse.UsageStop(request).catch(() => undefined)
    }

    /**
     * Takes a deleted entry out of the scan, and out of every total above it. `isDir` tells a
     * folder from a file of the same name, which a bucket can hold.
     */
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

    /** Marks the scan as one that the core no longer holds. */
    lost = (request: string) => {
        this.update(request, (s) => ({ ...s, phase: 'gone' }))
    }
}

/**
 * The root that a scan from the folder `from` would read (`gdrive:`, `/`), as the core works it
 * out, so the menu can name what each panel would scan. It is undefined while it loads, and when
 * `from` is null or can't be scanned.
 */
export function useUsageRoot(from: string | null): string | undefined {
    const [root, setRoot] = useState<{ from: string; root: string } | null>(null)
    useEffect(() => {
        if (from === null) return
        let current = true
        browse.UsageRoot(from).then(
            (r) => {
                if (current) setRoot({ from, root: r })
            },
            () => undefined
        )
        return () => {
            current = false
        }
    }, [from])
    return root && root.from === from ? root.root : undefined
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

/** How often (in ms) the folder shown is read again while the scan runs. */
export const USAGE_BEAT = 500

/** A folder of the scan as the core last returned it, with the order it was asked in. */
export interface ShownLevel {
    rel: string
    by: UsageSort
    level: Browse.UsageLevel
}

/**
 * Reads the first `limit` rows of the scan's folder `rel`, in the order `by`. It reads them again
 * every `USAGE_BEAT` while the scan runs, and once more when the scan ends or changes. `onMissing`
 * is called when the scan has no such folder (it was deleted), and `onLost` when the core no
 * longer holds the scan.
 */
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
