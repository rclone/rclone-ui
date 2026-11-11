import { cn } from '@heroui/react'
import type { ReactNode } from 'react'

/**
 * The title of a part of a window ("Running now", "Options"). It has one size for every window,
 * so the parts of the app read the same way.
 */
export function SectionTitle({
    title,
    description,
    actions,
    id,
    className,
}: {
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    /** For the section's aria-labelledby. */
    id?: string
    className?: string
}) {
    return (
        <div className={cn('flex items-end gap-3', className)}>
            <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                <h2 id={id} className="text-[15px] font-semibold leading-tight">
                    {title}
                </h2>
                {description && (
                    <p className="leading-snug text-small text-default-500 text-pretty">
                        {description}
                    </p>
                )}
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
    )
}
