import { cn } from '@heroui/react'
import type { ReactNode } from 'react'

/**
 * Which shape a settings group takes. The desktop window is a narrow column of right-aligned
 * labels against their fields; a browser tab is wide, so the same group becomes a card with its
 * title above full-width controls.
 */
export type SettingsLayout = 'native' | 'web'

export default function SettingsGroup({
    layout,
    title,
    description,
    contentClassName,
    children,
}: {
    layout: SettingsLayout
    title: string
    description?: string
    /** Spacing between the group's own controls; the same in both layouts. */
    contentClassName?: string
    children: ReactNode
}) {
    if (layout === 'web') {
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
    return (
        <div className="flex flex-row justify-center w-full gap-8 px-8">
            <div className="flex flex-col items-end flex-1 gap-2">
                <h3 className="font-medium">{title}</h3>
                {description && <p className="text-xs text-neutral-500 text-end">{description}</p>}
            </div>
            <div className={cn('flex flex-col w-3/5 gap-3', contentClassName)}>{children}</div>
        </div>
    )
}
