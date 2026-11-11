import { Accordion, AccordionItem, Chip, cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import {
    AngleLeftSmall as AngleLeftSmallIcon,
    BoxSimple as BoxSimpleIcon,
    Filter as FilterIcon,
    type Page as PageIcon,
    ServerSimple as ServerSimpleIcon,
    SlidersSimple as SlidersSimpleIcon,
    TagSimple as TagSimpleIcon,
} from '@zappicon/react'
import { type ReactNode, useId, useMemo } from 'react'
import { formatNumber } from '../../../lib/format'
import { WINDOWS } from '../../routes'
import { IconTile } from '../look/IconTile'
import { Panel } from '../look/Panel'
import { SectionTitle } from '../look/SectionTitle'
import type { Tone } from '../look/tones'

// The tile, title and purpose of each option group. An operation's own group has the look of its
// window (WINDOWS in src/routes.ts), so Sync's options are green like the Sync window, and the
// shared groups have tones of their own.
export const CATEGORY_META: Record<
    | 'copy'
    | 'sync'
    | 'move'
    | 'bisync'
    | 'mount'
    | 'vfs'
    | 'serve'
    | 'filters'
    | 'config'
    | 'metadata'
    | 'remotes',
    {
        title: string
        // Any Zappicon icon. They all share one type, which includes the variants.
        icon: typeof PageIcon
        tone: Tone
        purpose: string
    }
> = {
    copy: { ...WINDOWS.copy, purpose: t`How files are compared and copied` },
    sync: { ...WINDOWS.sync, purpose: t`How files are compared, copied and deleted` },
    move: { ...WINDOWS.move, purpose: t`How files are compared and moved` },
    bisync: { ...WINDOWS.bisync, purpose: t`How the two sides are compared and kept alike` },
    mount: { ...WINDOWS.mount, purpose: t`How the drive appears and behaves` },
    vfs: {
        title: t({
            message: 'VFS',
            comment: "The name of an option group: rclone's virtual file system, which mounts use.",
        }),
        icon: BoxSimpleIcon,
        tone: 'orange',
        purpose: t`Caching and buffering on this computer`,
    },
    serve: { ...WINDOWS.serve, purpose: t`How the server listens and behaves` },
    filters: {
        title: t`Filters`,
        icon: FilterIcon,
        tone: 'pink',
        purpose: t`Which files are included or left out`,
    },
    metadata: {
        title: t`Metadata`,
        icon: TagSimpleIcon,
        tone: 'indigo',
        purpose: t`Which metadata comes along, and how it changes`,
    },
    config: {
        title: t({
            message: 'Config',
            comment: "The name of an option group: rclone's general settings.",
        }),
        icon: SlidersSimpleIcon,
        tone: 'graphite',
        purpose: t`Speed, retries and other general settings`,
    },
    remotes: {
        title: t`Remotes`,
        icon: ServerSimpleIcon,
        tone: 'fuchsia',
        purpose: t`Settings of the remotes in the paths, for this run only`,
    },
}

export type OptionCategory = keyof typeof CATEGORY_META

export interface OptionsAccordionItemDef {
    key: string
    category: OptionCategory
    /**
     * The group's options as set, which its title counts. The remotes group holds an object of
     * options for each remote.
     */
    options?: Record<string, unknown>
    children: ReactNode
}

/** How many options are set. With `nested` (the remotes group), the options inside each remote. */
function setCount(options: Record<string, unknown>, nested = false): number {
    let count = 0
    for (const value of Object.values(options)) {
        if (value === undefined) continue
        if (!nested) count += 1
        else if (value && typeof value === 'object') {
            count += setCount(value as Record<string, unknown>)
        }
    }
    return count
}

/**
 * The option groups shared by the operation pages, in one panel with a row for each group. A row
 * shows what its group is for, with how many of its options are set beside its title. Opening it
 * shows the group's editor, which useOptionItems builds (OptionGroupEditor or RemoteOptionsEditor).
 */
export default function OptionsAccordion({
    items,
    defaultExpandedKeys,
    all = false,
}: {
    items: OptionsAccordionItemDef[]
    defaultExpandedKeys?: string[]
    /** Opens every item at once, and lets several stay open (the template drawer). */
    all?: boolean
}) {
    const accordionItems = useMemo(
        () =>
            items.map((item) => {
                const meta = CATEGORY_META[item.category]
                const count = item.options ? setCount(item.options, item.category === 'remotes') : 0
                return (
                    <AccordionItem
                        key={item.key}
                        aria-label={meta.title}
                        startContent={<IconTile icon={meta.icon} tone={meta.tone} size="lg" />}
                        indicator={<AngleLeftSmallIcon className="size-5" />}
                        title={
                            <span className="flex items-center gap-2">
                                {meta.title}
                                {count > 0 && (
                                    <Chip
                                        size="sm"
                                        variant="flat"
                                        classNames={{
                                            base: 'h-5 px-0.5',
                                            content: 'px-1 font-semibold tabular-nums text-tiny',
                                        }}
                                    >
                                        {formatNumber(count)}
                                    </Chip>
                                )}
                            </span>
                        }
                        subtitle={<span className="block truncate">{meta.purpose}</span>}
                    >
                        {item.children}
                    </AccordionItem>
                )
            }),
        [items]
    )

    return (
        <Panel className="overflow-hidden">
            <Accordion
                keepContentMounted={true}
                className="px-0"
                dividerProps={{ className: 'ms-[66px] w-auto bg-divider' }}
                itemClasses={{
                    trigger: cn(
                        'px-4 py-3 gap-3.5 transition-colors duration-150',
                        'data-[hover=true]:bg-default-100/50 data-[focus-visible=true]:outline-offset-[-2px]'
                    ),
                    titleWrapper: 'min-w-0 gap-0.5',
                    title: 'font-medium text-medium',
                    subtitle: 'text-small text-default-500 min-w-0',
                    indicator: 'text-default-400',
                    content: 'px-4 pt-1 pb-4',
                }}
                selectionMode={all ? 'multiple' : undefined}
                defaultExpandedKeys={all ? 'all' : defaultExpandedKeys}
            >
                {accordionItems}
            </Accordion>
        </Panel>
    )
}

export function OptionsSection({
    items,
    defaultExpandedKeys,
    title = t`Options`,
}: {
    items: OptionsAccordionItemDef[]
    defaultExpandedKeys?: string[]
    title?: string
}) {
    const id = useId()
    return (
        <section aria-labelledby={id} className="flex flex-col gap-3">
            <SectionTitle id={id} title={title} className="px-1" />
            <OptionsAccordion items={items} defaultExpandedKeys={defaultExpandedKeys} />
        </section>
    )
}
