import { createPluginRegistration } from '@embedpdf/core'
import { EmbedPDF } from '@embedpdf/core/react'
import { usePdfiumEngine } from '@embedpdf/engines/react'
// Bundle PDFium's wasm locally (via Vite ?url) so the preview works offline inside
// the Tauri webview instead of reaching for the default CDN url.
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import {
    DocumentContent,
    DocumentManagerPluginPackage,
} from '@embedpdf/plugin-document-manager/react'
import { RenderLayer, RenderPluginPackage } from '@embedpdf/plugin-render/react'
import { ScrollPluginPackage, Scroller, useScroll } from '@embedpdf/plugin-scroll/react'
import { TilingLayer, TilingPluginPackage } from '@embedpdf/plugin-tiling/react'
import { Viewport, ViewportPluginPackage } from '@embedpdf/plugin-viewport/react'
import { ZoomMode, ZoomPluginPackage, useZoom } from '@embedpdf/plugin-zoom/react'
import { Button } from '@heroui/react'
import { DownloadIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { PreviewError, PreviewLoading, type PreviewViewerProps } from './previewStates'
import usePreviewSource from './usePreviewSource'

export default function PdfPreview({ url, name, authHeader, onDownload }: PreviewViewerProps) {
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
        // Desktop app: never fetch fallback fonts from a remote CDN.
        fontFallback: null,
    })

    // Fetch the bytes ourselves and hand PDFium a buffer. This avoids EmbedPDF's
    // default range-request loader (which the rclone serve endpoint doesn't reliably
    // answer) and the webview CORS block. No wasm arg: the pdfium wasm is loaded by
    // the engine (usePdfiumEngine) above, not via setWasmSource.
    const { buffer, error: fetchError, progress } = usePreviewSource(url, authHeader)

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
                                        message={documentState.error ?? 'Failed to open document'}
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

function PdfViewport({
    documentId,
    onDownload,
}: {
    documentId: string
    onDownload: () => void
}) {
    const containerRef = useRef<HTMLDivElement>(null)
    const lastWidthRef = useRef(0)
    const { provides: zoom } = useZoom(documentId)

    // Fit the page to the viewport width on load AND whenever the container's WIDTH
    // changes (e.g. expanding the drawer to 97%). The plugin's own `defaultZoomLevel`
    // is unreliable because the viewport only mounts after the document loads, so its
    // initial recalc runs while clientWidth is still 0. A ResizeObserver fires once the
    // element has a width; we defer a frame so EmbedPDF's viewport metrics are populated.
    //
    // Two guards keep this from fighting the user: only react to width changes (ignore
    // height/scrollbar churn), and only auto-fit while still in fit-width mode — once the
    // user zooms manually, we leave their zoom alone instead of snapping back to fit
    // (which otherwise produced a resize/zoom flicker loop).
    useEffect(() => {
        const el = containerRef.current
        if (!el || !zoom) return
        const observer = new ResizeObserver(() => {
            const width = el.clientWidth
            if (width === 0 || width === lastWidthRef.current) return
            lastWidthRef.current = width
            requestAnimationFrame(() => {
                if (zoom.getState().zoomLevel === ZoomMode.FitWidth) {
                    zoom.requestZoom(ZoomMode.FitWidth)
                }
            })
        })
        observer.observe(el)
        return () => observer.disconnect()
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

function PdfToolbar({
    documentId,
    onDownload,
}: {
    documentId: string
    onDownload: () => void
}) {
    const { state: zoomState, provides: zoom } = useZoom(documentId)
    const { state: scrollState } = useScroll(documentId)

    return (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b shrink-0 border-divider bg-default-50">
            <div className="flex items-center gap-1">
                <Button
                    isIconOnly={true}
                    size="sm"
                    variant="light"
                    onPress={() => zoom?.zoomOut()}
                    data-focus-visible="false"
                >
                    <ZoomOutIcon className="size-4" />
                </Button>
                <span className="w-12 text-xs text-center tabular-nums text-default-600">
                    {Math.round(zoomState.currentZoomLevel * 100)}%
                </span>
                <Button
                    isIconOnly={true}
                    size="sm"
                    variant="light"
                    onPress={() => zoom?.zoomIn()}
                    data-focus-visible="false"
                >
                    <ZoomInIcon className="size-4" />
                </Button>
            </div>
            <span className="text-xs tabular-nums text-default-500">
                {scrollState.currentPage} / {scrollState.totalPages}
            </span>
            <Button
                isIconOnly={true}
                size="sm"
                variant="light"
                onPress={onDownload}
                data-focus-visible="false"
            >
                <DownloadIcon className="size-4" />
            </Button>
        </div>
    )
}
