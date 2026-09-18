import { cn } from '@heroui/react'
import { isNativeMac } from '../../lib/api/os'

export default function OperationWindowContent({
    children,
    className,
}: { children: React.ReactNode; className?: string }) {
    return (
        <div
            className={cn(
                'flex flex-col flex-1 w-full max-w-3xl gap-6 pt-10 mx-auto',
                isNativeMac && 'pt-14',
                className
            )}
        >
            {children}
        </div>
    )
}
