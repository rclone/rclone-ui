import { cn } from '@heroui/react'

import type React from 'react'
import { isNativeMac } from '../../../lib/api/os'

export default function BaseSection({
    children,
    header,
    className,
}: {
    children: React.ReactNode
    header: Parameters<typeof BaseHeader>[0]
    className?: string
}) {
    return (
        <div className="flex flex-col gap-8">
            <div
                className={cn(
                    'sticky top-0 flex flex-col z-50 bg-white/50 dark:bg-[#12121299] backdrop-blur-lg',
                    isNativeMac ? 'pt-2' : undefined
                )}
            >
                <BaseHeader {...header} />
            </div>
            <div className={cn('flex flex-col gap-10', className)}>{children}</div>
        </div>
    )
}

function BaseHeader({ title, endContent }: { title: string; endContent?: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between p-4 h-14 ">
            <h2 className="text-xl font-semibold">{title}</h2>
            {endContent}
        </div>
    )
}
