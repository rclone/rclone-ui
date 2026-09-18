import { cn } from '@heroui/react'
import { ArrowRightIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

// The Dashboard's building blocks: a labelled panel, its eyebrow, a "more" link and a figure.

export function Eyebrow({ children, right }: { children: ReactNode; right?: ReactNode }) {
    return (
        <div className="flex items-baseline justify-between mb-3">
            <span className="text-[11px] font-medium tracking-[0.14em] uppercase text-default-500">
                {children}
            </span>
            {right}
        </div>
    )
}

export function Panel({
    label,
    className,
    children,
}: {
    /** Names the panel as a landmark (`aria-label`). */
    label?: string
    className?: string
    children: ReactNode
}) {
    return (
        <section
            aria-label={label}
            className={cn(
                'rounded-2xl border border-divider bg-content1 dark:border-neutral-800 dark:bg-[#171717] p-5',
                className
            )}
        >
            {children}
        </section>
    )
}

export function MoreLink({ to, children }: { to: string; children: ReactNode }) {
    return (
        <Link
            to={to}
            className="inline-flex items-center gap-1 text-xs text-default-500 rounded-md outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-primary"
        >
            {children}
            <ArrowRightIcon className="w-3 h-3" />
        </Link>
    )
}

export function Figure({ value, className }: { value: ReactNode; className?: string }) {
    return <span className={cn('font-mono tabular-nums text-foreground', className)}>{value}</span>
}
