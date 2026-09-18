import usePreviewBytes from './usePreviewBytes'
import usePreviewWasm from './usePreviewWasm'

/**
 * Prepares an inline viewer's input: fetches the document bytes (CORS-safe) and, when
 * the viewer needs it, configures the library's wasm — exposing the buffer only once
 * BOTH are ready.
 *
 * The @extend-ai libraries parse in a Web Worker that instantiates wasm from the
 * configured source, so the viewer must not mount before `setWasmSource` runs; gating
 * on this hook's `buffer` (null until wasm is configured) enforces that in one place.
 * Pass no `wasmUrl`/`setWasmSource` for viewers that manage their own wasm (PdfPreview).
 */
export default function usePreviewSource(
    url: string,
    authHeader: string | undefined,
    wasmUrl?: string,
    setWasmSource?: (source: ArrayBuffer) => void
): { buffer: ArrayBuffer | null; error: string | null; progress: number | null } {
    const wasmReady = usePreviewWasm(wasmUrl, setWasmSource)
    const { buffer, error, progress } = usePreviewBytes(url, authHeader)

    return { buffer: wasmReady ? buffer : null, error, progress }
}
