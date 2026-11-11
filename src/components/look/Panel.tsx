import { cn } from '@heroui/react'
import type { ReactNode } from 'react'

/**
 * The surface that groups and cards sit on: a rounded panel lifted off the window by a hairline
 * and a soft shadow (a hairline alone in the dark theme, where shadows don't show).
 */
export const SURFACE = [
    'rounded-2xl bg-content1',
    'shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_2px_rgb(0_0_0/0.04),0_6px_16px_-4px_rgb(0_0_0/0.06)]',
    'dark:shadow-[0_0_0_1px_rgb(255_255_255/0.07)]',
].join(' ')

/** The hover shadow of a SURFACE that is a button. */
export const SURFACE_HOVER = [
    'hover:shadow-[0_0_0_1px_rgb(0_0_0/0.1),0_2px_4px_rgb(0_0_0/0.05),0_12px_24px_-8px_rgb(0_0_0/0.16)]',
    'dark:hover:shadow-[0_0_0_1px_rgb(255_255_255/0.16),0_12px_24px_-8px_rgb(0_0_0/0.8)]',
].join(' ')

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
    return <div className={cn('relative', SURFACE, className)}>{children}</div>
}
