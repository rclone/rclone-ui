import { cn, DrawerFooter, DrawerHeader } from '@heroui/react'
import { type ReactNode, type Ref, useLayoutEffect } from 'react'
import { platform } from '../../lib/shell'
import type { WindowLook } from '../routes'
import { TONE_RGB } from './look/tones'
import { WindowHeader } from './look/WindowHeader'

/**
 * A window of the app's settings: Remotes, Notifications or Mobile & Remote Control. Its header
 * and an optional toolbar stay at the top, and the content scrolls below them. On macOS the title
 * bar lies over the window's top, so the window starts under it.
 */
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
    /** The header's title, when it isn't the window's own (look.title). */
    title?: string
    description?: ReactNode
    actions?: ReactNode
    /** Under the header and fixed with it, such as a search field. */
    toolbar?: ReactNode
    children: ReactNode
    /** The element that scrolls the content, for a list that virtualizes its rows. */
    scrollRef?: Ref<HTMLDivElement>
    /** Classes for the column that holds the content. */
    className?: string
}) {
    // The sheets open outside the window's <main>, so the window's tone is set on the whole page
    // too, for their wash.
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

/** The column that a sheet's header, body and footer share, so their edges line up. */
export const SHEET_COLUMN = 'w-full max-w-2xl mx-auto'

/**
 * The classes of a sheet: a drawer that covers the window, such as the one that creates a remote.
 * `tone-wash` draws the window's tone at its top, from the `--tone` that SettingsWindow sets.
 */
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

/** The foot of a sheet: secondary actions on the left, then Cancel and the main action. */
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
