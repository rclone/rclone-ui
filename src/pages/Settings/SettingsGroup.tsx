import { cn, Switch } from '@heroui/react'
import { type ComponentType, type ReactNode, useId } from 'react'
import { IconTile } from '../../components/look/IconTile'
import { Panel } from '../../components/look/Panel'
import type { Tone } from '../../components/look/tones'

type IconType = ComponentType<{ className?: string }>

/** The classes of HeroUI's Tabs when they stand in for a segmented control, without panels. */
export const SEGMENTED = {
    tabList: 'p-1 gap-1',
    tab: 'h-7 px-3',
    panel: 'hidden',
}

/** A group of settings. `id` is its anchor in the window, which `?section=` scrolls to. */
export function SettingsGroup({
    id,
    icon,
    tone,
    title,
    description,
    children,
    className,
}: {
    id?: string
    icon: IconType
    tone: Tone
    title: string
    description?: ReactNode
    children: ReactNode
    className?: string
}) {
    const headingId = useId()
    return (
        <section id={id} aria-labelledby={headingId} className="flex flex-col gap-3 scroll-mt-5">
            <header className="flex items-center gap-3 px-1">
                <IconTile icon={icon} tone={tone} size="lg" />
                <div className="flex flex-col min-w-0 gap-0.5">
                    <h2 id={headingId} className="text-[17px] font-semibold leading-tight">
                        {title}
                    </h2>
                    {description && (
                        <p className="leading-snug text-small text-default-500 text-pretty">
                            {description}
                        </p>
                    )}
                </div>
            </header>
            <Panel className={cn('divide-y divide-divider', className)}>{children}</Panel>
        </section>
    )
}

/**
 * One setting: its name and a line about it on the left, its control on the right. When the
 * control is wide, `stacked` puts it under the text.
 */
export function SettingRow({
    title,
    titleId,
    description,
    children,
    stacked,
    className,
}: {
    title: ReactNode
    titleId?: string
    description?: ReactNode
    children?: ReactNode
    stacked?: boolean
    className?: string
}) {
    return (
        <div
            className={cn(
                'flex gap-x-6 gap-y-3 px-5 py-4',
                stacked ? 'flex-col' : 'flex-row flex-wrap items-center justify-between',
                className
            )}
        >
            <div className="flex flex-col flex-1 min-w-52 gap-0.5">
                <span id={titleId} className="font-medium text-small">
                    {title}
                </span>
                {description && (
                    <span className="text-xs leading-relaxed text-default-500 text-pretty">
                        {description}
                    </span>
                )}
            </div>
            {children}
        </div>
    )
}

/** A setting that is on or off, with a switch. The title says what happens when it is on. */
export function SwitchRow({
    title,
    description,
    isSelected,
    isDisabled,
    onValueChange,
}: {
    title: string
    description?: ReactNode
    isSelected: boolean
    isDisabled?: boolean
    onValueChange: (value: boolean) => void
}) {
    // HeroUI's Switch drops its aria-label when it has no text, so the row's title names it.
    const titleId = useId()
    return (
        <SettingRow title={title} titleId={titleId} description={description}>
            <Switch
                size="sm"
                isSelected={isSelected}
                isDisabled={isDisabled}
                onValueChange={onValueChange}
                aria-labelledby={titleId}
                data-focus-visible="false"
                classNames={{ wrapper: 'me-0' }}
            />
        </SettingRow>
    )
}
