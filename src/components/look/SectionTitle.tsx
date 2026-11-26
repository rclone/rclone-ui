import { cn } from '@heroui/react'
import type { ReactNode } from 'react'

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
