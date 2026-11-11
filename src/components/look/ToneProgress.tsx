import { cn } from '@heroui/react'
import { TONE_GRADIENT, type Tone } from './tones'

/**
 * A thin progress bar in a tone's gradient. `value` is from 0 to 1. Without one, for work of
 * unknown length, the bar shows a moving stripe (a half-filled bar with reduced motion).
 */
export function ToneProgress({
    tone,
    value,
    label,
    className,
}: {
    tone: Tone
    value?: number
    /** What the bar measures, for screen readers ("Copying photos"). */
    label: string
    className?: string
}) {
    const known = value !== undefined && Number.isFinite(value)
    const pct = known ? Math.round(Math.min(1, Math.max(0, value)) * 100) : undefined
    return (
        <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className={cn(
                'relative h-1.5 w-full overflow-hidden rounded-full bg-default-200/70',
                className
            )}
        >
            <div
                className={cn(
                    'absolute inset-y-0 left-0 rounded-full bg-linear-to-r',
                    TONE_GRADIENT[tone],
                    known
                        ? 'transition-[width] duration-500 ease-out'
                        : 'w-1/3 animate-[tone-progress_1.4s_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:w-1/2'
                )}
                style={known ? { width: `${pct}%` } : undefined}
            />
        </div>
    )
}
