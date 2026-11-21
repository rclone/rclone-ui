import { type AlertProps, cn, Alert as HeroAlert } from '@heroui/react'

/**
 * HeroUI's Alert with the app's text styles, kept at the height of its content. HeroUI's own has
 * `flex-grow`, so it stretches in a column that has room to spare. `!grow-0` needs the `!`,
 * because tailwind-merge doesn't know the `flex-grow` class and so can't replace it.
 */
export default function Alert({ className, classNames, radius = 'lg', ...props }: AlertProps) {
    return (
        <HeroAlert
            {...props}
            radius={radius}
            className={cn('!grow-0', className)}
            classNames={{
                ...classNames,
                title: cn('font-medium text-[13px] leading-snug', classNames?.title),
                description: cn('text-xs leading-relaxed text-pretty', classNames?.description),
            }}
        />
    )
}
