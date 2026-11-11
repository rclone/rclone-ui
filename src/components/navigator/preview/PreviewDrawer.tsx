import { Button, cn, DrawerBody, DrawerContent, Tooltip } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    CompressWide as CompressWideIcon,
    DownloadBracket as DownloadBracketIcon,
    ExpandWide as ExpandWideIcon,
    File as PlainFileIcon,
} from '@zappicon/react'
import {
    type ComponentType,
    type LazyExoticComponent,
    lazy,
    Suspense,
    useCallback,
    useState,
} from 'react'
import { formatErrorMessage, reportError } from '../../../../lib/errors'
import { formatBytes, formatDate } from '../../../../lib/format'
import { openUrl } from '../../../../lib/shell'
import ContentDrawer, { DrawerShellHeader } from '../../ContentDrawer'
import FileIcon, { fileTypeName, getFileType, isPreviewable } from '../FileIcon'
import type { Entry } from '../types'
import { getFileExtension } from '../utils'
import { mediaUrl, useMediaUrl } from './media'
import {
    DOCUMENT_MAX,
    PreviewBoundary,
    PreviewError,
    PreviewLoading,
    PreviewNotice,
    type PreviewViewerProps,
} from './previewStates'

function FileTile({ entry }: { entry: Entry }) {
    return (
        <span className="grid size-16 place-items-center rounded-[18px] bg-content1 shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_6px_16px_-4px_rgb(0_0_0/0.15)] dark:bg-default-100 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.08)] [&>svg]:size-8">
            <FileIcon entry={entry} size="lg" />
        </span>
    )
}

// Lazy-loaded so that each viewer's heavy WASM or WebGL bundle loads only when a matching file
// is opened. This keeps them out of the main bundle and the Browser bundle.
const PdfPreview = lazy(() => import('./PdfPreview'))
const DocxPreview = lazy(() => import('./DocxPreview'))
const XlsxPreview = lazy(() => import('./XlsxPreview'))
const PptxPreview = lazy(() => import('./PptxPreview'))
const CodeMirrorPreview = lazy(() => import('./CodeMirrorPreview'))

const CODE_VIEWER_TYPES = new Set(['text', 'code', 'config'])

// Shown with the browser's own elements, directly from the signed URL.
const MEDIA_TYPES = new Set(['image', 'video', 'audio'])

// Documents open in a dedicated inline viewer, chosen by extension. Any other extension falls
// through to the media and text cases, or to the download fallback below.
const DOCUMENT_VIEWERS: Record<string, LazyExoticComponent<ComponentType<PreviewViewerProps>>> = {
    pdf: PdfPreview,
    docx: DocxPreview,
    xlsx: XlsxPreview,
    ppt: PptxPreview,
    pptx: PptxPreview,
}

const DOWNLOAD = t({ message: 'Download', comment: 'Button: downloads the file.' })

function tooLargeWords(bytes: number): string {
    const size = formatBytes(bytes)
    const max = formatBytes(DOCUMENT_MAX)
    return t({
        message: `${size} (max: ${max})`,
        comment: 'The size of a file, and the largest size that the preview opens.',
    })
}

export default function PreviewDrawer({
    item,
    onClose,
}: {
    item: Entry | null
    onClose: () => void
}) {
    // When expanded, the drawer widens to almost the full width of the window (97vw).
    const [expanded, setExpanded] = useState(false)

    const fileType = item ? getFileType(item) : 'unknown'
    const typeName = fileTypeName(fileType)
    const canPreview = item ? isPreviewable(item) : false
    const ext = item ? getFileExtension(item.name) : ''
    const DocumentViewer: LazyExoticComponent<ComponentType<PreviewViewerProps>> | undefined =
        DOCUMENT_VIEWERS[ext]
    // Only documents have a size limit (DOCUMENT_MAX). Images, video and audio stream through
    // the signed URL whatever their size, and the text viewer loads only the start of a large
    // file (CodeMirrorPreview).
    const isTooLarge = !!DocumentViewer && item?.size !== undefined && item.size > DOCUMENT_MAX

    // The core streams the file through a signed URL that supports ranges, so a video can seek.
    const media = useMediaUrl(item && canPreview && !isTooLarge ? item.fullPath : undefined)
    const previewUrl = media.url ?? null

    // The URL that an <img>, <video> or <audio> element couldn't load (missing, refused, expired,
    // or in a format it can't play). It is stored by URL, so the next file starts fresh.
    const [failedUrl, setFailedUrl] = useState<string | null>(null)

    // Downloads the file as an attachment, which the system browser saves.
    const handleDownload = useCallback(() => {
        if (!item) return
        mediaUrl(item.fullPath, false)
            .then(openUrl)
            .catch((error: unknown) =>
                reportError(error, {
                    title: DOWNLOAD,
                    fallback: t`Could not get a download link for this file.`,
                    log: ['[preview] download link'],
                })
            )
    }, [item])

    const handleClose = useCallback(() => {
        setExpanded(false)
        onClose()
    }, [onClose])

    const renderPreview = () => {
        if (!item) {
            return (
                <div className="flex flex-col items-center justify-center h-full gap-3 text-sm text-default-500">
                    <PlainFileIcon className="size-12 text-default-300" />
                    <p>
                        <Trans>Select a file to preview</Trans>
                    </p>
                </div>
            )
        }

        // Shown for types that can't be rendered inline, and for formats of an otherwise
        // previewable type that no viewer handles (such as .odt).
        const unsupportedFallback = (
            <PreviewNotice
                visual={<FileTile entry={item} />}
                title={t`Preview not available for this file type`}
                description={t`Download the file to access it locally.`}
                onDownload={handleDownload}
            />
        )

        if (!canPreview) {
            return unsupportedFallback
        }

        if (isTooLarge) {
            return (
                <PreviewNotice
                    visual={<FileTile entry={item} />}
                    title={t`File is too large to preview`}
                    description={tooLargeWords(item.size ?? 0)}
                    onDownload={handleDownload}
                />
            )
        }

        // There is no URL, so nothing below could show the file.
        if (media.error) {
            return (
                <PreviewError
                    message={formatErrorMessage(media.error, t`The file could not be opened.`)}
                    onDownload={handleDownload}
                />
            )
        }

        // The viewers receive the URL while it is still being signed and show it as loading, so
        // a viewer that is already open stays mounted from one file to the next.
        if (DocumentViewer) {
            return <DocumentViewer url={previewUrl} name={item.name} onDownload={handleDownload} />
        }

        // A .csv file is classified as a spreadsheet, but it is shown as delimited text.
        if (CODE_VIEWER_TYPES.has(fileType) || ext === 'csv') {
            return (
                <CodeMirrorPreview url={previewUrl} name={item.name} onDownload={handleDownload} />
            )
        }

        if (MEDIA_TYPES.has(fileType)) {
            if (!previewUrl) return <PreviewLoading />
            if (failedUrl === previewUrl) return <PreviewError onDownload={handleDownload} />
        }
        const onMediaError = () => setFailedUrl(previewUrl)

        switch (fileType) {
            case 'image':
                return (
                    <div className="flex items-center justify-center w-full h-full p-4">
                        <img
                            src={previewUrl ?? undefined}
                            alt={item.name}
                            className="object-contain max-w-full max-h-full rounded-lg"
                            onError={onMediaError}
                        />
                    </div>
                )

            case 'video':
                return (
                    <div className="flex items-center justify-center w-full h-full p-4">
                        {/* biome-ignore lint/a11y/useMediaCaption: the user's own files have no captions to offer */}
                        <video
                            src={previewUrl ?? undefined}
                            controls={true}
                            className="max-w-full max-h-full rounded-lg"
                            autoPlay={false}
                            onError={onMediaError}
                        >
                            <Trans>This video can’t be played here.</Trans>
                        </video>
                    </div>
                )

            case 'audio':
                return (
                    <div className="flex flex-col items-center justify-center w-full h-full gap-4 p-6">
                        <FileTile entry={item} />
                        <p className="text-sm font-semibold text-center">{item.name}</p>
                        {/* biome-ignore lint/a11y/useMediaCaption: the user's own files have no captions to offer */}
                        <audio
                            src={previewUrl ?? undefined}
                            controls={true}
                            className="w-full max-w-md"
                            onError={onMediaError}
                        >
                            <Trans>This audio can’t be played here.</Trans>
                        </audio>
                    </div>
                )

            default:
                return (
                    <PreviewNotice
                        visual={<FileTile entry={item} />}
                        title={t`Preview not available`}
                        onDownload={handleDownload}
                    />
                )
        }
    }

    return (
        <ContentDrawer
            isOpen={!!item}
            placement="right"
            size="md"
            onClose={handleClose}
            hideCloseButton={true}
            classNames={{
                base: cn(
                    'transition-[max-width] duration-300 ease-in-out',
                    expanded && 'max-w-[97vw]!'
                ),
            }}
        >
            <DrawerContent>
                <DrawerShellHeader
                    leading={
                        item && (
                            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-content1 shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_1px_2px_rgb(0_0_0/0.08)] dark:bg-default-100 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.08)]">
                                <FileIcon entry={item} size="md" />
                            </span>
                        )
                    }
                    title={item?.name ?? t({ message: 'Preview', context: 'heading' })}
                    description={
                        item && (
                            <span>
                                {typeName}
                                {item.size !== undefined && (
                                    <span className="normal-case tabular-nums">
                                        {' · '}
                                        {formatBytes(item.size)}
                                    </span>
                                )}
                            </span>
                        )
                    }
                    actions={
                        item && (
                            <>
                                <Tooltip content={DOWNLOAD} size="sm" closeDelay={0}>
                                    <Button
                                        isIconOnly={true}
                                        size="sm"
                                        variant="light"
                                        radius="full"
                                        aria-label={DOWNLOAD}
                                        onPress={handleDownload}
                                        className="text-default-500"
                                    >
                                        <DownloadBracketIcon className="size-4" />
                                    </Button>
                                </Tooltip>
                                <Tooltip
                                    content={expanded ? t`Collapse preview` : t`Expand preview`}
                                    size="sm"
                                    closeDelay={0}
                                >
                                    <Button
                                        isIconOnly={true}
                                        size="sm"
                                        variant="light"
                                        radius="full"
                                        aria-label={
                                            expanded ? t`Collapse preview` : t`Expand preview`
                                        }
                                        onPress={() => setExpanded((value) => !value)}
                                        className="text-default-500"
                                    >
                                        {expanded ? (
                                            <CompressWideIcon className="size-4" />
                                        ) : (
                                            <ExpandWideIcon className="size-4" />
                                        )}
                                    </Button>
                                </Tooltip>
                            </>
                        )
                    }
                    onClose={handleClose}
                    closeLabel={t`Close preview`}
                    className="gap-2.5"
                />
                <DrawerBody className="p-0">
                    <div className="flex flex-col h-full">
                        <div className="relative flex-1 overflow-hidden">
                            <PreviewBoundary
                                resetKey={item?.fullPath ?? ''}
                                onDownload={handleDownload}
                            >
                                <Suspense fallback={<PreviewLoading />}>{renderPreview()}</Suspense>
                            </PreviewBoundary>
                        </div>

                        {item && (
                            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 px-5 py-3.5 text-xs border-t shrink-0 border-divider bg-content1/70">
                                <dt className="text-default-500">
                                    {t({ message: 'Type', comment: 'Label: the type of a file.' })}
                                </dt>
                                <dd className="text-right">{typeName}</dd>
                                {item.size !== undefined && (
                                    <>
                                        <dt className="text-default-500">
                                            {t({
                                                message: 'Size',
                                                comment: 'The size of a file.',
                                            })}
                                        </dt>
                                        <dd className="text-right tabular-nums">
                                            {formatBytes(item.size)}
                                        </dd>
                                    </>
                                )}
                                {item.modTime && (
                                    <>
                                        <dt className="text-default-500">
                                            {t({
                                                message: 'Modified',
                                                comment: 'Label: when a file was last changed.',
                                            })}
                                        </dt>
                                        <dd className="text-right tabular-nums">
                                            {Number.isNaN(Date.parse(item.modTime))
                                                ? item.modTime
                                                : formatDate(item.modTime)}
                                        </dd>
                                    </>
                                )}
                                <dt className="text-default-500">
                                    {t({ message: 'Location', comment: 'Label: where a file is.' })}
                                </dt>
                                <dd className="text-right truncate" title={item.fullPath}>
                                    {item.remote === 'UI_LOCAL_FS'
                                        ? t({
                                              message: 'Local',
                                              comment: 'Where a file is: on this computer.',
                                          })
                                        : item.remote}
                                </dd>
                            </dl>
                        )}
                    </div>
                </DrawerBody>
            </DrawerContent>
        </ContentDrawer>
    )
}
