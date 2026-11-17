import { XlsxViewer, setWasmSource } from '@extend-ai/react-xlsx'
// Bundle the sheets wasm locally (Vite ?url) so it loads same-origin offline.
import xlsxWasmUrl from '@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url'
import { PreviewError, PreviewLoading, type PreviewViewerProps } from './previewStates'
import usePreviewSource from './usePreviewSource'

export default function XlsxPreview({ url, name, authHeader, onDownload }: PreviewViewerProps) {
    const { buffer, error, progress } = usePreviewSource(
        url,
        authHeader,
        xlsxWasmUrl,
        setWasmSource
    )

    if (error) {
        return <PreviewError message={error} onDownload={onDownload} />
    }

    if (!buffer) {
        return <PreviewLoading progress={progress} />
    }

    return (
        <div className="w-full h-full">
            <XlsxViewer
                file={buffer}
                fileName={name}
                readOnly={true}
                // Preview is always light-themed regardless of the app theme.
                isDark={false}
                showDefaultToolbar={false}
                height="100%"
                loadingState={<PreviewLoading />}
                errorState={(err) => <PreviewError message={err.message} onDownload={onDownload} />}
                fileTooLargeState={
                    <PreviewError message="File is too large to preview" onDownload={onDownload} />
                }
            />
        </div>
    )
}
