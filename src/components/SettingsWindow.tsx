import { cn, DrawerFooter, DrawerHeader } from '@heroui/react'
import { type ReactNode, type Ref, useLayoutEffect } from 'react'
import { platform } from '../../lib/shell'
import type { WindowLook } from '../routes'
import { TONE_RGB } from './look/tones'
import { WindowHeader } from './look/WindowHeader'

export default function SettingsWindow({
    look,
    title,
    description,
    actions,
    toolbar,
    children,
    scrollRef,
    className,
}: {
    look: WindowLook
    title?: string
    description?: ReactNode
    actions?: ReactNode
    toolbar?: ReactNode
    children: ReactNode
    scrollRef?: Ref<HTMLDivElement>
    className?: string
}) {
    useLayoutEffect(() => {
        document.documentElement.style.setProperty('--tone', TONE_RGB[look.tone])
    }, [look.tone])

    return (
        <div className={cn('flex flex-col w-screen h-screen', platform() === 'macos' && 'pt-7')}>
            <div className="px-6 pt-4 pb-4 shrink-0">
                <div className="flex flex-col w-full max-w-3xl gap-4 mx-auto">
                    <WindowHeader
                        look={look}
                        title={title}
                        description={description}
                        actions={actions}
                    />
                    {toolbar}
                </div>
            </div>
            <div
                ref={scrollRef}
                className="relative flex-1 min-h-0 overflow-y-auto overscroll-none [mask-image:linear-gradient(to_bottom,transparent,black_12px)]"
            >
                <div className="px-6 pt-2 pb-10">
                    <div className={cn('w-full max-w-3xl mx-auto', className)}>{children}</div>
                </div>
            </div>
        </div>
    )
}

export const SHEET_COLUMN = 'w-full max-w-2xl mx-auto'

export function sheetClass(className?: string) {
    return cn('bg-content1 tone-wash', platform() === 'macos' && 'pt-5', className)
}

export function SheetHeader({
    tile,
    title,
    description,
    actions,
}: {
    tile: ReactNode
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
}) {
    return (
        <DrawerHeader className="pt-5 pb-3">
            <div className={cn(SHEET_COLUMN, 'flex items-center gap-3.5')}>
                {tile}
                <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                    <h2 className="text-xl font-semibold leading-tight tracking-tight truncate">
                        {title}
                    </h2>
                    {description && (
                        <p className="font-normal leading-snug text-small text-default-500 text-pretty">
                            {description}
                        </p>
                    )}
                </div>
                {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
            </div>
        </DrawerHeader>
    )
}

export function SheetFooter({ start, children }: { start?: ReactNode; children: ReactNode }) {
    return (
        <DrawerFooter className="border-t border-divider">
            <div className={cn(SHEET_COLUMN, 'flex items-center gap-2')}>
                {start}
                <div className="flex items-center justify-end flex-1 gap-2">{children}</div>
            </div>
        </DrawerFooter>
    )
}
