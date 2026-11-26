import { cn } from '@heroui/react'
import type { ReactNode } from 'react'
import { Panel } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'

const WIDTHS = {
    medium: 'w-44',
    normal: 'w-full max-w-xs',
    wide: 'flex-1',
} as const

export function rowField(width: keyof typeof WIDTHS = 'normal') {
    return {
        base: 'flex-row items-start justify-between w-full max-w-none gap-x-6 px-4 py-2.5',
        label: 'shrink-0 w-32 p-0 pt-1.5 me-0 font-medium text-small text-foreground',
        mainWrapper: cn('min-w-0', WIDTHS[width]),
        helperWrapper: 'px-1',
    }
}

export function FieldGroup({
    title,
    description,
    actions,
    id,
    children,
    className,
}: {
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    id?: string
    children: ReactNode
    className?: string
}) {
    return (
        <section aria-labelledby={id} className="flex flex-col gap-3">
            <SectionTitle id={id} title={title} description={description} actions={actions} />
            <Panel className={cn('flex flex-col divide-y divide-divider', className)}>
                {children}
            </Panel>
        </section>
    )
}
