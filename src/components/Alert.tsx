import { type AlertProps, cn, Alert as HeroAlert } from '@heroui/react'

export default function Alert({ className, classNames, radius = 'lg', ...props }: AlertProps) {
    return (
        <HeroAlert
            {...props}
            radius={radius}
            // HeroUI's Alert has `flex-grow`, which tailwind-merge doesn't know, so `grow-0`
            // needs the `!`.
            className={cn('!grow-0', className)}
            classNames={{
                ...classNames,
                title: cn('font-medium text-[13px] leading-snug', classNames?.title),
                description: cn('text-xs leading-relaxed text-pretty', classNames?.description),
            }}
        />
    )
}
