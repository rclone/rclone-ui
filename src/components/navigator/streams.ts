// The slow reads behind the panels (a listing, a search, folder sizes, a compare), which the jobs
// in jobs.ts run. A listing, a search and a size count send their results as they find them. The
// bound call (browse.List, Search or Sizes) runs for as long as the work does. Meanwhile the core
// sends the results to this window as events (`browse:rows`, `browse:size`), tagged with the
// request id that was passed to the call. Cancelling the call stops rclone's work.

import type { CancellablePromise } from '@wailsio/runtime'
import { browse as api } from '../../../lib/core/api'
import type { Browse } from '../../../lib/core/types'
import { type CoreEvents, onLive } from '../../../lib/live'
import type { JobArgs } from './jobs'

type Streamed = 'browse:rows' | 'browse:size'

/**
 * Runs `call` with a new request id and passes each `name` event for that request to `onPiece`,
 * in order, including the last one (`done`). Resolves once the last event arrives, and rejects
 * with the call's error. Aborting `signal` cancels the call and stops listening.
 */
export function follow<N extends Streamed>(
    name: N,
    call: (request: string) => CancellablePromise<void>,
    onPiece: (piece: CoreEvents[N]) => void,
    signal?: AbortSignal
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason)
            return
        }
        const request = crypto.randomUUID()
        let ended = false
        const end = () => {
            ended = true
            off()
            signal?.removeEventListener('abort', abort)
        }
        // The call's return value and its events arrive separately. The read ends with the last
        // event rather than with the return value, so no piece that arrives later is lost.
        const off = onLive(name, (piece) => {
            if (ended || piece.request !== request) return
            onPiece(piece)
            if (piece.done) {
                end()
                resolve()
            }
        })
        const running = call(request)
        function abort() {
            if (ended) return
            end()
            running.cancel()
            reject(signal?.reason)
        }
        signal?.addEventListener('abort', abort, { once: true })
        running.catch((error: unknown) => {
            if (ended) return
            end()
            reject(error)
        })
    })
}

function cancelling<T>(call: CancellablePromise<T>, signal: AbortSignal): Promise<T> {
    const abort = () => call.cancel()
    signal.addEventListener('abort', abort, { once: true })
    return call.finally(() => signal.removeEventListener('abort', abort))
}

/** Receives a job's results while its read runs, and the details when it ends. */
export interface Sink<T> {
    add(items: T[]): void
    progress(n: number): void
    end(info: { fetchedAt?: number; capped?: boolean }): void
}

/** A job's read. `signal` aborts it, for example on new arguments or an unmount. */
export type Run<T> = (
    args: JobArgs,
    fresh: boolean,
    signal: AbortSignal,
    sink: Sink<T>
) => Promise<void>

/** Lists a folder's rows, from the core's cache unless `fresh` is set. */
export const runList: Run<Browse.Row> = (args, fresh, signal, sink) =>
    follow(
        'browse:rows',
        (request) => api.List(request, String(args.path), fresh, args.fileDates === true),
        (piece) => {
            if (piece.entries.length > 0) sink.add(piece.entries)
            if (piece.done) sink.end({ fetchedAt: piece.fetchedAt, capped: piece.capped })
        },
        signal
    )

/** Finds the entries below a folder whose names contain `q`. */
export const runSearch: Run<Browse.Row> = (args, _fresh, signal, sink) =>
    follow(
        'browse:rows',
        (request) =>
            api.Search(request, String(args.path), String(args.q), args.fileDates === true),
        (piece) => {
            if (piece.entries.length > 0) sink.add(piece.entries)
            if (piece.done) sink.end({ capped: piece.capped })
        },
        signal
    )

/** Counts each folder's size and reports each one as soon as it is known. */
export const runSizes: Run<Browse.FolderSize> = (args, _fresh, signal, sink) => {
    const paths = Array.isArray(args.paths) ? args.paths : []
    let counted = 0
    return follow(
        'browse:size',
        (request) => api.Sizes(request, paths),
        (piece) => {
            if (piece.done) {
                sink.end({})
                return
            }
            sink.add([piece])
            counted += 1
            sink.progress(counted)
        },
        signal
    )
}

/** Compares two folders. The result arrives all at once. */
export const runCompare: Run<Browse.Pair> = async (args, _fresh, signal, sink) => {
    const res = await cancelling(
        api.Compare(String(args.left), String(args.right), args.fileDates === true),
        signal
    )
    sink.add(res.pairs ?? [])
    sink.end({ capped: res.capped })
}

/** The reads, keyed by the job kind passed to useJob. */
export const RUNS = {
    list: runList,
    search: runSearch,
    sizes: runSizes,
    compare: runCompare,
} as Record<'list' | 'search' | 'sizes' | 'compare', Run<unknown>>
