import { Button } from '@heroui/react'
import { t } from '@lingui/core/macro'
import {
    DownloadBracket as DownloadBracketIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
} from '@zappicon/react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { formatNumber } from '../../../../lib/format'
import { toneButton } from '../../look/buttons'
import { IconTile } from '../../look/IconTile'
import { ToneProgress } from '../../look/ToneProgress'

export const DOCUMENT_MAX = 100_000_000

export interface PreviewViewerProps {
    url: string | null
    name: string
    onDownload: () => void
}

export function PreviewLoading({ progress }: { progress?: number | null }) {
    const determinate = typeof progress === 'number'

    return (
        <div className="flex flex-col items-center justify-center w-full h-full gap-3">
            <ToneProgress
                tone="blue"
                label={t`Loading preview…`}
                value={determinate ? progress : undefined}
                className="max-w-[14rem]"
            />
            <span className="text-xs tabular-nums text-default-500">
                {determinate
                    ? formatNumber(progress, { style: 'percent', maximumFractionDigits: 0 })
                    : t`Loading preview…`}
            </span>
        </div>
    )
}

export function PreviewNotice({
    visual,
    title,
    description,
    onDownload,
}: {
    visual: ReactNode
    title: string
    description?: ReactNode
    onDownload: () => void
}) {
    return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
            {visual}
            <div className="flex flex-col items-center gap-1 max-w-80">
                <p className="text-sm font-semibold">{title}</p>
                {description && (
                    <p className="text-xs leading-relaxed text-default-500 text-pretty [overflow-wrap:anywhere]">
                        {description}
                    </p>
                )}
            </div>
            <Button
                color="primary"
                size="sm"
                className={toneButton('blue')}
                onPress={onDownload}
                startContent={<DownloadBracketIcon className="size-4" />}
                data-focus-visible="false"
            >
                {t({ message: 'Download', comment: 'Button: downloads the file.' })}
            </Button>
        </div>
    )
}

export function PreviewError({
    message,
    onDownload,
}: {
    message?: string
    onDownload: () => void
}) {
    return (
        <PreviewNotice
            visual={<IconTile icon={ExclamationTriangleIcon} tone="red" size="xl" />}
            title={t`Could not load preview`}
            description={message}
            onDownload={onDownload}
        />
    )
}

export class PreviewBoundary extends Component<
    { resetKey: string; onDownload: () => void; children: ReactNode },
    { error: Error | null; key: string }
> {
    state = { error: null as Error | null, key: this.props.resetKey }

    static getDerivedStateFromError(error: Error) {
        return { error }
    }

    static getDerivedStateFromProps(
        props: { resetKey: string },
        state: { error: Error | null; key: string }
    ) {
        return props.resetKey === state.key ? null : { error: null, key: props.resetKey }
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('[preview] viewer failed', error, info.componentStack)
    }

    render() {
        if (!this.state.error) return this.props.children
        return (
            <PreviewError message={this.state.error.message} onDownload={this.props.onDownload} />
        )
    }
}
