import { useEffect, useState } from 'react'

// One shared fetch per wasm asset, reused across mounts (incl. StrictMode remounts).
const wasmCache = new Map<string, Promise<void>>()

/**
 * Fetches a viewer library's wasm (a same-origin, bundled asset — no CORS) and hands
 * it to that library's `setWasmSource` as an **ArrayBuffer**, then reports readiness.
 *
 * These libraries parse inside a Web Worker and forward the configured wasm source to
 * it. A string URL makes the worker fetch the wasm itself, which it can't resolve in
 * the Tauri webview — so we pass raw bytes instead: the buffer is structured-cloned to
 * the worker and instantiated directly. Gate the viewer on the returned flag so the
 * source is configured before the library spins up its worker.
 */
export default function usePreviewWasm(
    wasmUrl?: string,
    setWasmSource?: (source: ArrayBuffer) => void
): boolean {
    const [ready, setReady] = useState(false)

    useEffect(() => {
        // Nothing to configure — e.g. PdfPreview loads its own wasm via the engine.
        if (!wasmUrl || !setWasmSource) {
            setReady(true)
            return
        }

        let cancelled = false

        let promise = wasmCache.get(wasmUrl)
        if (!promise) {
            promise = fetch(wasmUrl)
                .then((res) => res.arrayBuffer())
                .then((buffer) => setWasmSource(buffer))
            wasmCache.set(wasmUrl, promise)
        }

        promise
            .then(() => {
                if (!cancelled) setReady(true)
            })
            .catch(() => {
                // Drop the failed attempt so a later mount can retry the fetch.
                wasmCache.delete(wasmUrl)
                // Leave `ready` false; the viewer stays on its loading state.
            })

        return () => {
            cancelled = true
        }
    }, [wasmUrl, setWasmSource])

    return ready
}
