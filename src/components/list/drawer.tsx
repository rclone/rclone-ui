import { cn } from '@heroui/react'
import type { ReactNode } from 'react'
import type { WindowLook } from '../../routes'
import { IconTile } from '../look/IconTile'
import { Panel } from '../look/Panel'
import { SectionTitle } from '../look/SectionTitle'
import { TONE_RGB } from '../look/tones'

// The parts of the drawers that the list windows open to make or edit a thing (a template, a
// watcher, an automount): a header in the window's look, and fields grouped in panels.

/** The drawer's surface: the window's background, so that the panels of fields stand out. */
export function drawerContentClass(macos: boolean) {
    return cn('bg-default-50 dark:bg-[#121212]', macos && 'pt-5')
}

export function SheetHeader({
    look,
    title,
    description,
}: {
    look: WindowLook
    title: ReactNode
    description?: ReactNode
}) {
    return (
        <div className="relative flex items-center w-full gap-3.5">
            <div
                aria-hidden={true}
                className="absolute pointer-events-none -inset-x-6 -top-24 h-64 opacity-70 dark:opacity-100"
                style={{
                    background: `radial-gradient(60% 100% at 15% 0%, rgb(${TONE_RGB[look.tone]} / 0.18), transparent 75%)`,
                }}
            />
            <IconTile icon={look.icon} tone={look.tone} size="xl" className="relative" />
            <div className="relative flex flex-col flex-1 min-w-0 gap-0.5">
                <h2 className="text-xl font-semibold leading-tight tracking-tight truncate">
                    {title}
                </h2>
                {description && (
                    <p className="text-sm font-normal leading-snug text-default-500 text-pretty">
                        {description}
                    </p>
                )}
            </div>
        </div>
    )
}

export function FieldGroup({
    title,
    description,
    actions,
    children,
    className,
}: {
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    children: ReactNode
    className?: string
}) {
    return (
        <section className="flex flex-col gap-2.5">
            <SectionTitle
                title={title}
                description={description}
                actions={actions}
                className="px-1"
            />
            <Panel className={cn('flex flex-col gap-5 p-5', className)}>{children}</Panel>
        </section>
    )
}
