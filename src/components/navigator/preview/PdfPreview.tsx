import { createPluginRegistration } from '@embedpdf/core'
import { EmbedPDF } from '@embedpdf/core/react'
import { usePdfiumEngine } from '@embedpdf/engines/react'
// PDFium's wasm is bundled (with Vite's ?url) rather than fetched from the default CDN URL.
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import {
    DocumentContent,
    DocumentManagerPluginPackage,
} from '@embedpdf/plugin-document-manager/react'
import { RenderLayer, RenderPluginPackage } from '@embedpdf/plugin-render/react'
import { Scroller, ScrollPluginPackage, useScroll } from '@embedpdf/plugin-scroll/react'
import { TilingLayer, TilingPluginPackage } from '@embedpdf/plugin-tiling/react'
import { Viewport, ViewportPluginPackage } from '@embedpdf/plugin-viewport/react'
import { useZoom, ZoomMode, ZoomPluginPackage } from '@embedpdf/plugin-zoom/react'
import { Button } from '@heroui/react'
import { t } from '@lingui/core/macro'
import {
    DownloadBracket as DownloadBracketIcon,
    SearchMinus as SearchMinusIcon,
    SearchPlus as SearchPlusIcon,
} from '@zappicon/react'
import { useEffect, useMemo, useRef } from 'react'
import { formatNumber } from '../../../../lib/format'
import { PreviewError, PreviewLoading, type PreviewViewerProps } from './previewStates'
import usePreviewSource from './usePreviewSource'

export default function PdfPreview({ url, name, onDownload }: PreviewViewerProps) {
    const {
        engine,
        isLoading: engineLoading,
        error: engineError,
    } = usePdfiumEngine({
        wasmUrl: pdfiumWasmUrl,
        // Run PDFium on the main thread. The worker engine's async create/destroy
        // lifecycle races with React StrictMode's double-mount, orphaning the
        // openDocumentBuffer request so the document hangs in "loading" forever.
        worker: false,
        // Never fetch fallback fonts from a remote CDN.
        fontFallback: null,
    })

    // Fetch the bytes here and pass PDFium a buffer. This avoids EmbedPDF's default loader,
    // which uses range requests and wasn't reliable against the media server. There is no wasm
    // argument, because the engine above (usePdfiumEngine) loads the PDFium wasm, not
    // setWasmSource.
    const { buffer, error: fetchError, progress } = usePreviewSource(url)

    const plugins = useMemo(
        () =>
            buffer
                ? [
                      createPluginRegistration(DocumentManagerPluginPackage, {
                          initialDocuments: [{ buffer, name }],
                      }),
                      createPluginRegistration(ViewportPluginPackage),
                      createPluginRegistration(ScrollPluginPackage),
                      createPluginRegistration(RenderPluginPackage),
                      createPluginRegistration(TilingPluginPackage),
                      createPluginRegistration(ZoomPluginPackage, {
                          defaultZoomLevel: ZoomMode.FitWidth,
                      }),
                  ]
                : null,
        [buffer, name]
    )

    const errorMessage = engineError?.message ?? fetchError

    if (errorMessage) {
        return <PreviewError message={errorMessage} onDownload={onDownload} />
    }

    if (engineLoading || !engine || !buffer || !plugins) {
        return <PreviewLoading progress={progress} />
    }

    return (
        // Re-key on the url so switching to another PDF reloads the document cleanly.
        <EmbedPDF key={url} engine={engine} plugins={plugins}>
            {({ activeDocumentId }) => {
                if (!activeDocumentId) {
                    return <PreviewLoading />
                }
                return (
                    <DocumentContent documentId={activeDocumentId}>
                        {({ isLoaded, isError, documentState }) => {
                            if (isError) {
                                return (
                                    <PreviewError
                                        message={documentState.error ?? t`Failed to open document`}
                                        onDownload={onDownload}
                                    />
                                )
                            }

                            if (!isLoaded) {
                                return <PreviewLoading />
                            }

                            return (
                                <PdfViewport
                                    documentId={activeDocumentId}
                                    onDownload={onDownload}
                                />
                            )
                        }}
                    </DocumentContent>
                )
            }}
        </EmbedPDF>
    )
}

function PdfViewport({ documentId, onDownload }: { documentId: string; onDownload: () => void }) {
    const containerRef = useRef<HTMLDivElement>(null)
    const lastWidthRef = useRef(0)
    const { provides: zoom } = useZoom(documentId)

    // Fit the page to the viewport width on load, and again whenever the container's width
    // changes (for example, when the drawer expands to 97%). The plugin's own `defaultZoomLevel`
    // is unreliable: the viewport mounts only after the document loads, so its first
    // calculation runs while clientWidth is still 0. A ResizeObserver fires once the element
    // has a width, and the fit waits one frame so that EmbedPDF's viewport metrics are ready.
    //
    // Two guards keep this from overriding the user. It reacts only to width changes, not to
    // height or scrollbar changes. And it fits only while the zoom is still in fit-width mode,
    // so a manual zoom is left alone. Snapping back to fit would start a loop of resizes and
    // zooms that flickers.
    useEffect(() => {
        const el = containerRef.current
        if (!el || !zoom) return
        // The last requested frame. It is cancelled on cleanup, because a frame that runs after
        // the viewer closes would zoom a document that no longer exists.
        let frame = 0
        const observer = new ResizeObserver(() => {
            const width = el.clientWidth
            if (width === 0 || width === lastWidthRef.current) return
            lastWidthRef.current = width
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                if (zoom.getState().zoomLevel === ZoomMode.FitWidth) {
                    zoom.requestZoom(ZoomMode.FitWidth)
                }
            })
        })
        observer.observe(el)
        return () => {
            observer.disconnect()
            cancelAnimationFrame(frame)
        }
    }, [zoom])

    return (
        <div ref={containerRef} className="flex flex-col w-full h-full">
            <PdfToolbar documentId={documentId} onDownload={onDownload} />
            <Viewport documentId={documentId} className="flex-1 min-h-0 bg-neutral-100">
                <Scroller
                    documentId={documentId}
                    renderPage={({ width, height, pageIndex }) => (
                        <div style={{ width, height }}>
                            <RenderLayer documentId={documentId} pageIndex={pageIndex} />
                            <TilingLayer documentId={documentId} pageIndex={pageIndex} />
                        </div>
                    )}
                />
            </Viewport>
        </div>
    )
}

function pageWords(current: number, total: number): string {
    const page = formatNumber(current)
    const pages = formatNumber(total)
    return t({
        message: `${page} / ${pages}`,
        comment: 'The page in view of a PDF, and its number of pages: "3 / 12".',
    })
}

function PdfToolbar({ documentId, onDownload }: { documentId: string; onDownload: () => void }) {
    const { state: zoomState, provides: zoom } = useZoom(documentId)
    const { state: scrollState } = useScroll(documentId)

    return (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b shrink-0 border-divider bg-default-50">
            <div className="flex items-center gap-1">
                <Button
                    isIconOnly={true}
                    size="sm"
                    variant="light"
                    aria-label={t`Zoom out`}
                    onPress={() => zoom?.zoomOut()}
                    data-focus-visible="false"
                >
                    <SearchMinusIcon className="size-4" />
                </Button>
                <span className="w-12 text-xs text-center tabular-nums text-default-600">
                    {formatNumber(zoomState.currentZoomLevel, {
                        style: 'percent',
                        maximumFractionDigits: 0,
                    })}
                </span>
                <Button
                    isIconOnly={true}
                    size="sm"
                    variant="light"
                    aria-label={t`Zoom in`}
                    onPress={() => zoom?.zoomIn()}
                    data-focus-visible="false"
                >
                    <SearchPlusIcon className="size-4" />
                </Button>
            </div>
            <span className="text-xs tabular-nums text-default-500">
                {pageWords(scrollState.currentPage, scrollState.totalPages)}
            </span>
            <Button
                isIconOnly={true}
                size="sm"
                variant="light"
                aria-label={t({ message: 'Download', comment: 'Button: downloads the file.' })}
                onPress={onDownload}
                data-focus-visible="false"
            >
                <DownloadBracketIcon className="size-4" />
            </Button>
        </div>
    )
}
