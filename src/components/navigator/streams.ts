import type { CancellablePromise } from '@wailsio/runtime'
import { browse as api } from '../../../lib/core/api'
import type { Browse } from '../../../lib/core/types'
import { type CoreEvents, onLive } from '../../../lib/live'
import type { JobArgs } from './jobs'

type Streamed = 'browse:rows' | 'browse:size'

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

export interface Sink<T> {
    add(items: T[]): void
    progress(n: number): void
    end(info: { fetchedAt?: number; capped?: boolean }): void
}

export type Run<T> = (
    args: JobArgs,
    fresh: boolean,
    signal: AbortSignal,
    sink: Sink<T>
) => Promise<void>

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

export const runSearch: Run<Browse.Row> = (args, _fresh, signal, sink) =>
    follow(
        'browse:rows',
        (request) =>
            api.Search(
                request,
                String(args.path),
                String(args.q),
                args.fileDates === true,
                args.hidden === true
            ),
        (piece) => {
            if (piece.entries.length > 0) sink.add(piece.entries)
            if (piece.done) sink.end({ capped: piece.capped })
        },
        signal
    )

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

export const runCompare: Run<Browse.Pair> = async (args, _fresh, signal, sink) => {
    const res = await cancelling(
        api.Compare(
            String(args.left),
            String(args.right),
            args.fileDates === true,
            args.hidden === true
        ),
        signal
    )
    sink.add(res.pairs ?? [])
    sink.end({ capped: res.capped })
}

export const RUNS = {
    list: runList,
    search: runSearch,
    sizes: runSizes,
    compare: runCompare,
} as Record<'list' | 'search' | 'sizes' | 'compare', Run<unknown>>
