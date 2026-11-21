import { cn } from '@heroui/react'
import type { ReactNode } from 'react'
import type { WindowLook } from '../../routes'
import { IconTile } from './IconTile'

export function WindowHeader({
    look,
    title,
    description,
    actions,
    className,
}: {
    look: WindowLook
    /** The title, when it isn't the window's own (look.title). */
    title?: ReactNode
    description?: ReactNode
    actions?: ReactNode
    className?: string
}) {
    return (
        <header className={cn('flex items-center gap-3.5', className)}>
            <IconTile icon={look.icon} tone={look.tone} size="xl" />
            <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                <h1 className="text-2xl font-semibold leading-tight tracking-tight font-rounded text-balance">
                    {title ?? look.title}
                </h1>
                {description && (
                    <p className="leading-snug text-small text-default-500 text-pretty">
                        {description}
                    </p>
                )}
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
    )
}
