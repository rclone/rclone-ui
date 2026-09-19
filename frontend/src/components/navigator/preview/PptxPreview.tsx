import { ReactPptxViewer, setWasmSource } from '@extend-ai/react-pptx'
// Bundle the pptx wasm locally (Vite ?url) so it loads same-origin offline.
import pptxWasmUrl from '@extend-ai/react-pptx/pptx_wasm_bg.wasm?url'
import '@extend-ai/react-pptx/styles.css'
import { PreviewError, PreviewLoading, type PreviewViewerProps } from './previewStates'
import usePreviewSource from './usePreviewSource'

export default function PptxPreview({ url, onDownload }: PreviewViewerProps) {
    const { buffer, error, progress } = usePreviewSource(
        url,
        pptxWasmUrl,
        setWasmSource
    )

    if (error) {
        return <PreviewError message={error} onDownload={onDownload} />
    }

    if (!buffer) {
        return <PreviewLoading progress={progress} />
    }

    return (
        <ReactPptxViewer
            source={buffer}
            showToolbar={false}
            showThumbnails={true}
            // Preview is always light-themed regardless of the app theme.
            className="w-full h-full bg-neutral-100"
            viewportClassName="bg-neutral-100"
            renderLoading={() => <PreviewLoading />}
            renderError={(err) => <PreviewError message={err.message} onDownload={onDownload} />}
        />
    )
}
