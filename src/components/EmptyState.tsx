import { cn } from '@heroui/react'
import type { ComponentType, ReactNode } from 'react'
import { IconTile } from './look/IconTile'
import { TONE_RGB, type Tone } from './look/tones'

/**
 * What a page or section shows when it has nothing to list. `children` go under the actions. It
 * fills its container and centres itself.
 */
export default function EmptyState({
    icon,
    tone = 'blue',
    eyebrow,
    title,
    description,
    actions,
    children,
    className,
}: {
    icon: ComponentType<{ className?: string }>
    /** The tile's tone, which is the window's (WINDOWS in src/routes.ts). */
    tone?: Tone
    /** A small line above the title, such as a chip. */
    eyebrow?: ReactNode
    title: string
    description?: ReactNode
    actions?: ReactNode
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
                <div className="relative isolate">
                    <div
                        aria-hidden={true}
                        className="absolute -z-10 -inset-10 blur-2xl opacity-60 dark:opacity-80"
                        style={{
                            background: `radial-gradient(closest-side, rgb(${TONE_RGB[tone]} / 0.45), transparent)`,
                        }}
                    />
                    <IconTile icon={icon} tone={tone} size="2xl" />
                </div>
                <div className="flex flex-col items-center gap-3">
                    {eyebrow}
                    <h1 className="text-[28px] font-semibold leading-tight tracking-tight font-rounded text-balance">
                        {title}
                    </h1>
                    {description && (
                        <p className="text-base leading-relaxed text-default-500 text-pretty">
                            {description}
                        </p>
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
