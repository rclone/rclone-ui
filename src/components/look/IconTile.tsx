import { cn } from '@heroui/react'
import type { ComponentType } from 'react'
import { GLOSS, TONE_GRADIENT, type Tone } from './tones'

const SIZES = {
    xs: 'size-5 rounded-[5px] [&>svg]:size-3',
    sm: 'size-6 rounded-md [&>svg]:size-3.5',
    md: 'size-7 rounded-lg [&>svg]:size-4',
    lg: 'size-9 rounded-[10px] [&>svg]:size-5',
    xl: 'size-12 rounded-[14px] [&>svg]:size-6',
    '2xl': 'size-16 rounded-[18px] [&>svg]:size-8',
} as const

export type TileSize = keyof typeof SIZES

export function IconTile({
    icon: Icon,
    tone,
    size = 'md',
    className,
}: {
    icon: ComponentType<{ className?: string }>
    tone: Tone
    size?: TileSize
    className?: string
}) {
    return (
        <span
            aria-hidden={true}
            className={cn(
                'grid shrink-0 place-items-center bg-linear-to-b text-white',
                GLOSS,
                TONE_GRADIENT[tone],
                SIZES[size],
                className
            )}
        >
            <Icon />
        </span>
    )
}
