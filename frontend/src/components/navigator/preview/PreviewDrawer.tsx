import { Button, Divider, Drawer, DrawerBody, DrawerContent, DrawerHeader, cn } from '@heroui/react'
import {
    DownloadIcon,
    FileIcon as FileIconLucide,
    Maximize2Icon,
    Minimize2Icon,
    XIcon,
} from 'lucide-react'
import {
    type ComponentType,
    type LazyExoticComponent,
    Suspense,
    lazy,
    useCallback,
    useMemo,
    useState,
} from 'react'
import { formatBytes, getFsInfo } from '../../../../lib/format.ts'
import { downloadLink } from '../../../../lib/api/app'
import { rcUrl } from '../../../../lib/api/rc'
import { openUrl } from '../../../../lib/api/shell'
import { useCurrentHost } from '../../../../store/persisted.ts'
import FileIcon, { getFileType, isPreviewable } from '../FileIcon'
import type { Entry } from '../types'
import { getFileExtension } from '../utils'
import { PreviewLoading, type PreviewViewerProps } from './previewStates'

// Lazy-loaded so each viewer's heavy WASM/WebGL bundle only loads when a matching
// file is actually opened, keeping them out of the main + Commander bundle.
const PdfPreview = lazy(() => import('./PdfPreview'))
const DocxPreview = lazy(() => import('./DocxPreview'))
const XlsxPreview = lazy(() => import('./XlsxPreview'))
const PptxPreview = lazy(() => import('./PptxPreview'))
// CodeMirror + its ~140 bundled languages are heavy; keep them out of the main chunk too.
const CodeMirrorPreview = lazy(() => import('./CodeMirrorPreview'))

// Text-like file types (plus .csv) render in the CodeMirror viewer.
const CODE_VIEWER_TYPES = new Set(['text', 'code', 'config'])

// Documents route to a dedicated inline viewer by extension; any other extension
// falls through to the media/text switch or the download fallback below.
const DOCUMENT_VIEWERS: Record<string, LazyExoticComponent<ComponentType<PreviewViewerProps>>> = {
    pdf: PdfPreview,
    docx: DocxPreview,
    xlsx: XlsxPreview,
    ppt: PptxPreview,
    pptx: PptxPreview,
}

const LEADING_SLASHES_RE = /^\/+/
const WINDOWS_DRIVE_RE = /^([a-zA-Z]:\/)/
const MAX_PREVIEW_SIZE = 500_000_000

// The daemon runs with `--rc-serve`, exposing objects at `/[fs]/remote/path` where
// `[fs]` is an rclone connection string. The local filesystem must be addressed via
// the `:local:` backend rooted at the filesystem root — the same fs the app uses for
// local `/operations/list` calls (see searchPath()/getFsInfo()). A bare `[local]`
// names a non-existent remote, so local previews 404'd while remotes worked.
function buildLocalFs(fullPath: string): { fs: string; path: string } {
    const normalized = fullPath.replace(/\\/g, '/')
    const drive = normalized.match(WINDOWS_DRIVE_RE)
    if (drive) {
        // e.g. C:/Users/x → fs ":local:C:/", path "Users/x"
        return {
            fs: `:local:${drive[1]}`,
            path: normalized.slice(drive[0].length).replace(LEADING_SLASHES_RE, ''),
        }
    }
    // POSIX absolute path → local backend rooted at "/", path relative to it.
    return { fs: ':local:/', path: normalized.replace(LEADING_SLASHES_RE, '') }
}

/**
 * The `[fs]` and remote path rclone's `--rc-serve` expects for an entry: the root as the entry
 * has it (`remote:`, or `remote:/` under the absolute root) and the path relative to it.
 */
function servePath(entry: Entry): { fs: string; path: string } {
    if (entry.remote === 'UI_LOCAL_FS') {
        return buildLocalFs(entry.fullPath)
    }
    const { root, filePath } = getFsInfo(entry.fullPath)
    return { fs: root, path: filePath }
}

// The server's rc proxy injects the host's credentials, so the page fetches previews with its
// own session and never sees a daemon password.
function buildPreviewUrl(entry: Entry, hostId: string): string {
    const { fs, path } = servePath(entry)
    const encoded = path
        .split('/')
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join('/')
    return rcUrl(hostId, `[${encodeURIComponent(fs)}]/${encoded}`)
}

export default function PreviewDrawer({
    item,
    onClose,
}: {
    item: Entry | null
    onClose: () => void
}) {
    const currentHost = useCurrentHost()
    const hostId = currentHost?.id

    // File previews are a PRO feature — without a valid license we tease the preview
    // behind an upsell overlay instead of unlocking it.

    // When expanded, the drawer widens to ~90% of the window (the Commander).
    const [expanded, setExpanded] = useState(false)

    const fileType = item ? getFileType(item) : 'unknown'
    const canPreview = item ? isPreviewable(item) : false

    const isTooLarge =
        item?.size !== undefined && MAX_PREVIEW_SIZE > 0 && item.size > MAX_PREVIEW_SIZE

    const previewUrl = useMemo(() => {
        if (!item || !hostId) return null
        return buildPreviewUrl(item, hostId)
    }, [item, hostId])

    // A signed, short-lived link: a desktop window's `open` lands in the system browser, which
    // has no session cookie, so the token is the credential.
    const handleDownload = useCallback(async () => {
        if (!item || !hostId) return
        const { fs, path } = servePath(item)
        try {
            const link = await downloadLink(hostId, fs, path)
            await openUrl(`${location.origin}${link}`)
        } catch (error) {
            console.error('[PreviewDrawer] download failed', error)
        }
    }, [item, hostId])

    const handleClose = useCallback(() => {
        setExpanded(false)
        onClose()
    }, [onClose])

    const renderPreview = () => {
        if (!item || !previewUrl) {
            return (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-default-500">
                    <FileIconLucide className="size-16" />
                    <p>Select a file to preview</p>
                </div>
            )
        }

        if (isTooLarge) {
            return (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-default-500">
                    <FileIcon entry={item} size="lg" />
                    <p>File is too large for preview</p>
                    <p className="text-sm">
                        {formatBytes(item.size ?? 0)} (max: {formatBytes(MAX_PREVIEW_SIZE)})
                    </p>
                    <Button
                        color="primary"
                        onPress={handleDownload}
                        startContent={<DownloadIcon className="size-4" />}
                    >
                        Download
                    </Button>
                </div>
            )
        }

        // Shown for types we can't render inline (and for the sub-formats of an
        // otherwise-previewable type that this viewer doesn't handle, e.g. .odt / .csv).
        const unsupportedFallback = (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-default-500">
                <FileIcon entry={item} size="lg" />
                <p>Preview not available for this file type</p>
                <Button
                    color="primary"
                    onPress={handleDownload}
                    startContent={<DownloadIcon className="size-4" />}
                >
                    Download
                </Button>
            </div>
        )

        if (!canPreview) {
            return unsupportedFallback
        }

        // Documents (pdf/docx/xlsx/pptx) route to their dedicated inline viewer;
        // unsupported document sub-formats (e.g. .odt) fall through to download.
        const ext = getFileExtension(item.name)
        const DocumentViewer = DOCUMENT_VIEWERS[ext]
        if (DocumentViewer) {
            return <DocumentViewer url={previewUrl} name={item.name} onDownload={handleDownload} />
        }

        // Text, code and config files — plus .csv (classified as a spreadsheet, but we
        // show it as delimited text) — render in the CodeMirror viewer.
        if (CODE_VIEWER_TYPES.has(fileType) || ext === 'csv') {
            return (
                <CodeMirrorPreview url={previewUrl} name={item.name} onDownload={handleDownload} />
            )
        }

        switch (fileType) {
            case 'image':
                return (
                    <div className="flex items-center justify-center w-full h-full p-4">
                        <img
                            src={previewUrl}
                            alt={item.name}
                            className="object-contain max-w-full max-h-full rounded-lg"
                        />
                    </div>
                )

            case 'video':
                return (
                    <div className="flex items-center justify-center w-full h-full p-4">
                        {/* biome-ignore lint/a11y/useMediaCaption: <explanation> */}
                        <video
                            src={previewUrl}
                            controls={true}
                            className="max-w-full max-h-full rounded-lg"
                            autoPlay={false}
                        >
                            Your browser does not support the video tag.
                        </video>
                    </div>
                )

            case 'audio':
                return (
                    <div className="flex flex-col items-center justify-center w-full h-full gap-4 p-4">
                        <FileIcon entry={item} size="lg" />
                        <p className="text-lg font-medium">{item.name}</p>
                        {/* biome-ignore lint/a11y/useMediaCaption: <explanation> */}
                        <audio src={previewUrl} controls={true} className="w-full max-w-md">
                            Your browser does not support the audio tag.
                        </audio>
                    </div>
                )

            default:
                return (
                    <div className="flex flex-col items-center justify-center h-full gap-4 text-default-500">
                        <FileIcon entry={item} size="lg" />
                        <p>Preview not available</p>
                        <Button
                            color="primary"
                            onPress={handleDownload}
                            startContent={<DownloadIcon className="size-4" />}
                        >
                            Download
                        </Button>
                    </div>
                )
        }
    }

    return (
        <Drawer
            isOpen={!!item}
            placement="right"
            size="md"
            onClose={handleClose}
            hideCloseButton={true}
            classNames={{
                base: cn(
                    'transition-[max-width] duration-300 ease-in-out',
                    expanded && '!max-w-[97vw]'
                ),
            }}
        >
            <DrawerContent>
                <DrawerHeader className="flex items-center justify-between mt-4">
                    <div className="flex items-center gap-2 overflow-hidden">
                        {item && (
                            <button
                                type="button"
                                onClick={() => setExpanded((value) => !value)}
                                aria-label={expanded ? 'Collapse preview' : 'Expand preview'}
                                className="relative grid shrink-0 cursor-pointer size-5 group place-items-center"
                            >
                                {/* File icon by default; hard-swaps to a maximize/
                                    minimize affordance on hover (only one is ever shown). */}
                                <span className="col-start-1 row-start-1 group-hover:hidden">
                                    <FileIcon entry={item} size="md" />
                                </span>
                                <span className="hidden col-start-1 row-start-1 group-hover:block">
                                    {expanded ? (
                                        <Minimize2Icon className="size-4" />
                                    ) : (
                                        <Maximize2Icon className="size-4" />
                                    )}
                                </span>
                            </button>
                        )}
                        <span className="font-medium truncate">{item?.name ?? 'Preview'}</span>
                    </div>
                    <Button isIconOnly={true} size="sm" variant="light" onPress={handleClose}>
                        <XIcon className="size-5" />
                    </Button>
                </DrawerHeader>
                <Divider />
                <DrawerBody className="p-0">
                    <div className="flex flex-col h-full">
                        <div className="relative flex-1 overflow-hidden">
                            <Suspense fallback={<PreviewLoading />}>{renderPreview()}</Suspense>
                        </div>

                        {item && (
                            <>
                                <Divider />
                                <div className="p-4 space-y-2 text-sm shrink-0 bg-default-50">
                                    <div className="flex justify-between">
                                        <span className="text-default-500">Type:</span>
                                        <span className="capitalize">{fileType}</span>
                                    </div>
                                    {item.size !== undefined && (
                                        <div className="flex justify-between">
                                            <span className="text-default-500">Size:</span>
                                            <span>{formatBytes(item.size)}</span>
                                        </div>
                                    )}
                                    {item.modTime && (
                                        <div className="flex justify-between">
                                            <span className="text-default-500">Modified:</span>
                                            <span>{item.modTime}</span>
                                        </div>
                                    )}
                                    <div className="flex justify-between">
                                        <span className="text-default-500">Location:</span>
                                        <span
                                            className="text-right truncate max-w-[200px]"
                                            title={item.fullPath}
                                        >
                                            {item.remote === 'UI_LOCAL_FS' ? 'Local' : item.remote}
                                        </span>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </DrawerBody>
            </DrawerContent>
        </Drawer>
    )
}
