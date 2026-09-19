import { cn } from '@heroui/react'

export default function OperationWindowContent({
    children,
    className,
}: { children: React.ReactNode; className?: string }) {
    return (
        <div className={cn('flex flex-col flex-1 w-full max-w-3xl gap-6 pt-10 mx-auto', className)}>
            {children}
        </div>
    )
}
