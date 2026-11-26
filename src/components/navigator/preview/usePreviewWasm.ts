import { t } from '@lingui/core/macro'
import { useEffect, useState } from 'react'

const wasmCache = new Map<string, Promise<void>>()

async function fetchWasm(wasmUrl: string): Promise<ArrayBuffer> {
    const res = await fetch(wasmUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.arrayBuffer()
}

/**
 * The library needs its wasm source before its first parse, so render the viewer only once
 * `ready` is set.
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
