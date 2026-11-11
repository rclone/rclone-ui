import { cn } from '@heroui/react'
import { platform } from '../../lib/shell'

export default function OperationWindowContent({
    children,
    className,
}: {
    children: React.ReactNode
    className?: string
}) {
    return (
        <div
            className={cn(
                'flex flex-col flex-1 w-full max-w-3xl gap-8 px-5 pt-8 pb-4 mx-auto',
                platform() === 'macos' && 'pt-12',
                className
            )}
        >
            {children}
        </div>
    )
}

/**
 * The whole of an operation page. It scrolls, and its action bar (OperationWindowFooter) stays at
 * the bottom of the window while it does.
 */
export function OperationPage({ children }: { children: React.ReactNode }) {
    return <div className="flex flex-col h-screen overflow-y-auto">{children}</div>
}
