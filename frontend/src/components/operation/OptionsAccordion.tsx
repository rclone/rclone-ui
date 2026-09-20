import { Accordion, AccordionItem, Avatar } from '@heroui/react'
import {
    ChevronDownIcon,
    ClockIcon,
    CopyIcon,
    DiamondPercentIcon,
    FilterIcon,
    FolderSyncIcon,
    MoveIcon,
    ServerIcon,
    TagsIcon,
    WrenchIcon,
} from 'lucide-react'
import { type ComponentType, type ReactNode, startTransition, useEffect, useMemo } from 'react'
import { usePersistedStore } from '@/store'

// Avatar/indicator/title per option category — exactly what each page's accordion rendered.
export const CATEGORY_META: Record<
    'copy' | 'sync' | 'move' | 'bisync' | 'filters' | 'cron' | 'config' | 'metadata' | 'remotes',
    {
        title: string
        icon: ComponentType<{ className?: string }>
        avatarColor?: 'primary' | 'success' | 'danger' | 'warning' | 'default'
        avatarClassName?: string
        avatarIconClassName?: string
    }
> = {
    copy: { title: 'Copy', icon: CopyIcon, avatarColor: 'primary' },
    sync: { title: 'Sync', icon: FolderSyncIcon, avatarColor: 'success' },
    move: { title: 'Move', icon: MoveIcon, avatarColor: 'primary' },
    bisync: {
        title: 'Bisync',
        icon: DiamondPercentIcon,
        avatarClassName: 'bg-lime-500',
        avatarIconClassName: 'text-success-foreground',
    },
    filters: { title: 'Filters', icon: FilterIcon, avatarColor: 'danger' },
    cron: { title: 'Schedule', icon: ClockIcon, avatarColor: 'warning' },
    config: { title: 'Config', icon: WrenchIcon, avatarColor: 'default' },
    metadata: {
        title: 'Metadata',
        icon: TagsIcon,
        avatarClassName: 'bg-violet-500',
        avatarIconClassName: 'text-success-foreground',
    },
    remotes: { title: 'Remotes', icon: ServerIcon, avatarClassName: 'bg-fuchsia-500' },
}

export type OptionCategory = keyof typeof CATEGORY_META

export interface OptionsAccordionItemDef {
    key: string
    category: OptionCategory
    subtitle?: string
    children: ReactNode
}

/**
 * The option-group accordion shared by the operation pages: item scaffolding (Avatar,
 * indicator, title) comes from CATEGORY_META; each item's content (OptionsSection /
 * CronSection / RemoteOptionsSection) stays page-supplied. `banner` wraps the accordion in the
 * relative div with the ShowMoreOptionsBanner (Copy/Sync/Move); Bisync/Delete/Purge omit it.
 */
export default function OptionsAccordion({
    items,
    defaultExpandedKeys,
    banner = false,
}: {
    items: OptionsAccordionItemDef[]
    defaultExpandedKeys?: string[]
    banner?: boolean
}) {
    const accordionItems = useMemo(
        () =>
            items.map((item) => {
                const meta = CATEGORY_META[item.category]
                const Icon = meta.icon
                return (
                    <AccordionItem
                        key={item.key}
                        startContent={
                            <Avatar
                                color={meta.avatarColor}
                                className={meta.avatarClassName}
                                radius="lg"
                                fallback={<Icon className={meta.avatarIconClassName} />}
                            />
                        }
                        indicator={<Icon />}
                        title={meta.title}
                        subtitle={item.subtitle}
                    >
                        {item.children}
                    </AccordionItem>
                )
            }),
        [items]
    )

    const accordion = (
        <Accordion
            keepContentMounted={true}
            dividerProps={{
                className: 'opacity-50',
            }}
            defaultExpandedKeys={defaultExpandedKeys}
        >
            {accordionItems}
        </Accordion>
    )

    if (!banner) {
        return accordion
    }

    return (
        <div className="relative flex flex-col">
            {accordion}
            <ShowMoreOptionsBanner />
        </div>
    )
}

// The page scrolls inside the Shell's outlet, not the window.
const scroller = () => document.querySelector('.browser-outlet')

// A one-time nudge pinned to the bottom of the banner-wrapped accordion, inviting the user to
// scroll for more options. Dismisses itself the first time the user scrolls, and is remembered.
function ShowMoreOptionsBanner() {
    const acknowledgements = usePersistedStore((state) => state.acknowledgements)

    const showMoreOptions = !acknowledgements.includes('showMoreOptions')

    useEffect(() => {
        if (acknowledgements.includes('showMoreOptions')) return

        const handleScroll = () => {
            usePersistedStore.setState((prev) => {
                if (prev.acknowledgements.includes('showMoreOptions')) return prev
                return {
                    acknowledgements: [...prev.acknowledgements, 'showMoreOptions'],
                }
            })
        }

        const target = scroller()
        target?.addEventListener('scroll', handleScroll, { once: true })

        return () => {
            target?.removeEventListener('scroll', handleScroll)
        }
    }, [acknowledgements])

    if (!showMoreOptions) return null

    return (
        <div
            className="absolute flex flex-col items-center justify-center w-full gap-1 bg-white dark:bg-[#121212] bottom-0 group py-2"
            onClick={() => {
                startTransition(() => {
                    usePersistedStore.setState((prev) => ({
                        acknowledgements: [...prev.acknowledgements, 'showMoreOptions'],
                    }))
                })
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        const target = scroller()
                        target?.scrollTo({ top: target.scrollHeight, behavior: 'smooth' })
                    }, 400)
                })
            }}
        >
            <p className="text-small animate-show-more-title group-hover:text-foreground-500 text-foreground-400">
                Show more options
            </p>
            <ChevronDownIcon className="size-5 stroke-foreground-400 animate-show-more group-hover:stroke-foreground-500" />
        </div>
    )
}
