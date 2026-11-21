import { cn } from '@heroui/react'

export type StatusKind = 'active' | 'success' | 'warning' | 'danger' | 'idle'

const DOT: Record<StatusKind, string> = {
    active: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    idle: 'bg-default-400',
}

/**
 * A dot in the color of a status. Put it beside a label that says the status in words: the dot
 * must not be the only cue.
 */
export function StatusDot({ kind, className }: { kind: StatusKind; className?: string }) {
    return (
        <span aria-hidden={true} className={cn('relative inline-flex size-2 shrink-0', className)}>
            {kind === 'active' && (
                <span
                    className={cn(
                        'absolute inset-0 rounded-full opacity-60 animate-ping motion-reduce:animate-none',
                        DOT[kind]
                    )}
                />
            )}
            <span className={cn('relative inline-flex rounded-full size-2', DOT[kind])} />
        </span>
    )
}
