import { Button, Progress } from '@heroui/react'
import { DownloadIcon } from 'lucide-react'

/** Common props shared by every inline file-preview viewer. */
export interface PreviewViewerProps {
    url: string
    name: string
    authHeader?: string
    onDownload: () => void
}

/**
 * Shared centered loading indicator for the preview area. Shows a determinate download
 * progress bar when `progress` (0..1) is known, and an indeterminate bar otherwise
 * (e.g. the server sent no Content-Length, or a viewer is still parsing/initializing).
 */
export function PreviewLoading({ progress }: { progress?: number | null }) {
    const determinate = typeof progress === 'number'
    const percent = determinate ? Math.round(progress * 100) : 0

    return (
        <div className="flex flex-col items-center justify-center w-full h-full gap-3">
            <Progress
                aria-label="Loading preview"
                size="sm"
                value={determinate ? percent : undefined}
                isIndeterminate={!determinate}
                className="max-w-[16rem]"
            />
            {determinate && (
                <span className="text-sm tabular-nums text-default-500">{percent}%</span>
            )}
        </div>
    )
}

/** Shared "couldn't render, download instead" fallback for the preview area. */
export function PreviewError({
    message,
    onDownload,
}: {
    message?: string
    onDownload: () => void
}) {
    return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-4 text-center text-default-500">
            <p>Could not load preview</p>
            {message && <p className="text-sm">{message}</p>}
            <Button
                color="primary"
                onPress={onDownload}
                startContent={<DownloadIcon className="size-4" />}
                data-focus-visible="false"
            >
                Download
            </Button>
        </div>
    )
}
