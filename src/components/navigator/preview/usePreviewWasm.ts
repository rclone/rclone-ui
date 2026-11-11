import { t } from '@lingui/core/macro'
import { useEffect, useState } from 'react'

// One shared fetch per wasm asset, reused across mounts (including StrictMode remounts).
const wasmCache = new Map<string, Promise<void>>()

async function fetchWasm(wasmUrl: string): Promise<ArrayBuffer> {
    const res = await fetch(wasmUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.arrayBuffer()
}

/**
 * Fetches a viewer library's wasm (a bundled asset on the same origin), passes it to that
 * library's `setWasmSource` as an ArrayBuffer, and then reports `ready`.
 *
 * These libraries parse inside a Web Worker and pass the configured wasm source on to it. The
 * bytes are passed rather than a URL, because the worker would have to resolve a URL itself.
 * Don't render the viewer until `ready` is set, so the source is configured before the library
 * starts its worker. If the wasm can't be loaded, `error` is set, because otherwise the viewer
 * would wait for the wasm forever.
 */
export default function usePreviewWasm(
    wasmUrl?: string,
    setWasmSource?: (source: ArrayBuffer) => void
): { ready: boolean; error: string | null } {
    const [state, setState] = useState<{ ready: boolean; error: string | null }>({
        ready: false,
        error: null,
    })

    useEffect(() => {
        // Nothing to configure. For example, PdfPreview loads its own wasm through its engine.
        if (!wasmUrl || !setWasmSource) {
            setState({ ready: true, error: null })
            return
        }

        let cancelled = false

        let promise = wasmCache.get(wasmUrl)
        if (!promise) {
            promise = fetchWasm(wasmUrl).then((buffer) => setWasmSource(buffer))
            wasmCache.set(wasmUrl, promise)
        }
        const attempt = promise

        attempt
            .then(() => {
                if (!cancelled) setState({ ready: true, error: null })
            })
            .catch((error: unknown) => {
                // Drop the failed attempt so a later mount can retry the fetch.
                if (wasmCache.get(wasmUrl) === attempt) wasmCache.delete(wasmUrl)
                if (cancelled) return
                const detail = error instanceof Error ? error.message : String(error)
                setState({ ready: false, error: t`The viewer could not load (${detail}).` })
            })

        return () => {
            cancelled = true
        }
    }, [wasmUrl, setWasmSource])

    return state
}
