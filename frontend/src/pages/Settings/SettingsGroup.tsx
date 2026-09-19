import { cn } from '@heroui/react'
import type { ReactNode } from 'react'

/** A settings group: a card with its title above full-width controls. */
export default function SettingsGroup({
    title,
    description,
    contentClassName,
    children,
}: {
    title: string
    description?: string
    /** Spacing between the group's own controls. */
    contentClassName?: string
    children: ReactNode
}) {
    return (
        <section className="flex flex-col gap-4 p-5 border rounded-large border-divider bg-content1">
            <div className="flex flex-col gap-1">
                <h3 className="font-medium">{title}</h3>
                {description && <p className="text-sm text-default-500">{description}</p>}
            </div>
            <div className={cn('flex flex-col gap-3', contentClassName)}>{children}</div>
        </section>
    )
}
