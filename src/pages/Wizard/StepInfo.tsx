import { Button } from '@heroui/react'
import { t } from '@lingui/core/macro'
import {
    ArrowUpRightSquare as ArrowUpRightSquareIcon,
    InfoCircle as InfoCircleIcon,
} from '@zappicon/react'
import { openUrl } from '../../../lib/shell'
import type { Info } from './flow'

export default function StepInfo({
    info,
    label = t`About this step`,
}: {
    info: Info
    label?: string
}) {
    const { paragraphs, link } = info
    return (
        <aside
            aria-label={label}
            className="flex gap-3 p-4 rounded-2xl bg-default-100/70 dark:bg-default-50/70"
        >
            <InfoCircleIcon className="mt-px size-5 shrink-0 text-default-400" />
            <div className="flex flex-col min-w-0 gap-2">
                <span className="font-semibold text-small">{label}</span>
                {paragraphs.map((text) => (
                    <p
                        key={text}
                        className="leading-relaxed text-small text-default-600 text-pretty"
                    >
                        {text}
                    </p>
                ))}
                {link && (
                    <Button
                        size="sm"
                        variant="flat"
                        className="self-start mt-1 bg-default-200/60"
                        endContent={<ArrowUpRightSquareIcon className="size-4" />}
                        onPress={() => openUrl(link.url)}
                    >
                        {link.label}
                    </Button>
                )}
            </div>
        </aside>
    )
}
