import { DOCUMENT_MAX } from './previewStates'
import usePreviewBytes from './usePreviewBytes'
import usePreviewWasm from './usePreviewWasm'

/**
 * Prepares the input of an inline viewer. It fetches the document's bytes and, when the viewer
 * needs it, configures the library's wasm. `buffer` stays null until both are ready.
 *
 * The @extend-ai libraries parse in a Web Worker that loads the wasm from the configured source,
 * so a viewer must not mount before `setWasmSource` runs. A viewer that waits for `buffer` is
 * safe. Leave out `wasmUrl` and `setWasmSource` for viewers that manage their own wasm
 * (PdfPreview). A document is read whole or not at all: a file larger than `DOCUMENT_MAX` is an
 * error.
 */
export default function usePreviewSource(
    url: string | null,
    wasmUrl?: string,
    setWasmSource?: (source: ArrayBuffer) => void
): { buffer: ArrayBuffer | null; error: string | null; progress: number | null } {
    const wasm = usePreviewWasm(wasmUrl, setWasmSource)
    const { buffer, error, progress } = usePreviewBytes(url, {
        maxBytes: DOCUMENT_MAX,
        whole: true,
    })

    return { buffer: wasm.ready ? buffer : null, error: wasm.error ?? error, progress }
}
