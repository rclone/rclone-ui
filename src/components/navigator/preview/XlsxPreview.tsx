import { setWasmSource, XlsxViewer } from '@extend-ai/react-xlsx'
// Bundle the sheets wasm locally (with Vite's ?url) so it loads from the same origin,
// even offline.
import xlsxWasmUrl from '@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url'
import { t } from '@lingui/core/macro'
import { locale } from '../../../../lib/i18n'
import { PreviewError, PreviewLoading, type PreviewViewerProps } from './previewStates'
import usePreviewSource from './usePreviewSource'

export default function XlsxPreview({ url, name, onDownload }: PreviewViewerProps) {
    const { buffer, error, progress } = usePreviewSource(url, xlsxWasmUrl, setWasmSource)

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
                // Numbers in the cells are written as the app's language writes them.
                locale={locale()}
                // The preview is always light, whatever the app theme is.
                isDark={false}
                showDefaultToolbar={false}
                height="100%"
                loadingState={<PreviewLoading />}
                errorState={(err) => <PreviewError message={err.message} onDownload={onDownload} />}
                fileTooLargeState={
                    <PreviewError
                        message={t`File is too large to preview`}
                        onDownload={onDownload}
                    />
                }
            />
        </div>
    )
}
