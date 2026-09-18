import { ReactDocxViewer, setWasmSource, useDocxModel } from '@extend-ai/react-docx'
// Bundle the docx layout wasm locally (Vite ?url) so it loads same-origin offline.
import docxWasmUrl from '@extend-ai/react-docx/docx_wasm_bg.wasm?url'
import { PreviewError, PreviewLoading, type PreviewViewerProps } from './previewStates'
import usePreviewSource from './usePreviewSource'

export default function DocxPreview({ url, authHeader, onDownload }: PreviewViewerProps) {
    // `buffer` is null until the wasm is configured, so parsing only starts once the
    // import worker can instantiate from the ArrayBuffer source.
    const {
        buffer,
        error: sourceError,
        progress,
    } = usePreviewSource(url, authHeader, docxWasmUrl, setWasmSource)
    const { model, isLoading: modelLoading, error: modelError } = useDocxModel(buffer ?? undefined)

    const errorMessage = sourceError ?? modelError?.message

    if (errorMessage) {
        return <PreviewError message={errorMessage} onDownload={onDownload} />
    }

    if (!buffer || modelLoading || !model) {
        return <PreviewLoading progress={progress} />
    }

    // text-black sets the inherited color so runs with no explicit color (docx "auto")
    // render black, instead of inheriting the app's light dark-mode text color.
    return (
        <div className="w-full h-full overflow-auto bg-neutral-100 text-black">
            <ReactDocxViewer model={model} />
        </div>
    )
}
