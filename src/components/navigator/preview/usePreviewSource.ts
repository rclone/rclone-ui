import { DOCUMENT_MAX } from './previewStates'
import usePreviewBytes from './usePreviewBytes'
import usePreviewWasm from './usePreviewWasm'

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
