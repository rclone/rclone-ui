import { cn } from '@heroui/react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * A page with nothing in it yet. Says what the page tracks, why it is empty, and what to do
 * next — in the dashboard's voice: a large title, one plain sentence, actions.
 */
export default function EmptyState({
    icon: Icon,
    eyebrow,
    title,
    description,
    actions,
    children,
    className,
}: {
    icon: LucideIcon
    /** A short tag above the title (a status like "Coming soon"). */
    eyebrow?: ReactNode
    title: string
    description?: string
    /** Buttons, rendered in a row under the description. */
    actions?: ReactNode
    /** Anything wider than a button row (an operation grid). */
    children?: ReactNode
    className?: string
}) {
    return (
        <div
            className={cn(
                'flex flex-col items-center justify-center w-full h-full min-h-[60vh] px-8 py-16',
                className
            )}
        >
            <div className="flex flex-col items-center w-full max-w-lg gap-6 text-center">
                <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 text-primary">
                    <Icon className="w-8 h-8" strokeWidth={1.75} />
                </div>
                <div className="flex flex-col items-center gap-4">
                    {eyebrow}
                    <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
                    {description && (
                        <p className="text-base leading-relaxed text-default-500">{description}</p>
                    )}
                </div>
                {actions && (
                    <div className="flex flex-wrap items-center justify-center gap-2">
                        {actions}
                    </div>
                )}
                {children && <div className="w-full pt-2">{children}</div>}
            </div>
        </div>
    )
}
