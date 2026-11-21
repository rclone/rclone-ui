import { ReactDocxViewer, setWasmSource, useDocxModel } from '@extend-ai/react-docx'
// Bundle the docx layout wasm locally (with Vite's ?url) so it loads from the same origin,
// even offline.
import docxWasmUrl from '@extend-ai/react-docx/docx_wasm_bg.wasm?url'
import { PreviewError, PreviewLoading, type PreviewViewerProps } from './previewStates'
import usePreviewSource from './usePreviewSource'

export default function DocxPreview({ url, onDownload }: PreviewViewerProps) {
    const {
        buffer,
        error: sourceError,
        progress,
    } = usePreviewSource(url, docxWasmUrl, setWasmSource)
    const { model, isLoading: modelLoading, error: modelError } = useDocxModel(buffer ?? undefined)

    const errorMessage = sourceError ?? modelError?.message

    if (errorMessage) {
        return <PreviewError message={errorMessage} onDownload={onDownload} />
    }

    if (!buffer || modelLoading || !model) {
        return <PreviewLoading progress={progress} />
    }

    // text-black sets the inherited color, so text with no explicit color (docx "auto") renders
    // black instead of taking the app's light text color in dark mode.
    return (
        <div className="w-full h-full overflow-auto bg-neutral-100 text-black">
            <ReactDocxViewer model={model} />
        </div>
    )
}
