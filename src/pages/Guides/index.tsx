import { Button, cn, Input, ScrollShadow } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    ArrowRightSmall as ArrowRightSmallIcon,
    GraduationCap as GraduationCapIcon,
    Search as SearchIcon,
    InfoCircle as TipIcon,
} from '@zappicon/react'
import { useMemo, useRef, useState } from 'react'
import { useSettings } from '../../../lib/settings'
import { launcher, openWindow, platform } from '../../../lib/shell'
import { IconTile } from '../../components/look/IconTile'
import { SURFACE, SURFACE_HOVER } from '../../components/look/Panel'
import { GLOSS, TONE_GRADIENT, TONE_TEXT, type Tone } from '../../components/look/tones'
import { usePageQuery, useSetPageQuery } from '../../route'
import { keycaps } from '../Settings/shortcut'
import { GUIDES, guideById, matches } from './guides'
import { LauncherDemo } from './LauncherDemo'
import { GuideText, KeyboardContext } from './text'
import { toneOf } from './tones'
import { type Action, CATEGORIES, type Guide } from './types'

const PARAM = 'guide'

function useShortcutCaps(): string[] {
    const { settings } = useSettings()
    const shortcut = settings?.general?.launcherShortcut || launcher.defaultShortcut()
    return useMemo(() => keycaps(shortcut, platform()), [shortcut])
}

/**
 * The Guides window: what Rclone UI can do and how, as short guides with steps that open the
 * windows they talk about. "All guides" shows them all as cards; a guide shows its steps.
 */
export default function Guides() {
    const pageQuery = usePageQuery()
    const setPageQuery = useSetPageQuery()
    const [selected, setSelected] = useState<string | null>(() => {
        const id = pageQuery.get(PARAM)
        return id && guideById(id) ? id : null
    })
    const [query, setQuery] = useState('')
    const term = query.trim()
    const shortcut = useShortcutCaps()
    const os = platform()
    const keyboard = useMemo(() => ({ shortcut, mac: os === 'macos' }), [shortcut, os])
    const content = useRef<HTMLDivElement>(null)

    const shown = useMemo(() => GUIDES.filter((g) => matches(g, query, os)), [query, os])
    const guide = selected ? guideById(selected) : undefined

    const select = (id: string | null) => {
        setSelected(id)
        // The address shows the guide, so a reload opens it again.
        setPageQuery({ [PARAM]: id })
        content.current?.scrollTo({ top: 0 })
    }

    return (
        <KeyboardContext.Provider value={keyboard}>
            <div className={cn('flex w-screen h-screen', platform() === 'macos' && 'pt-7')}>
                <nav
                    aria-label={t`Guides`}
                    className="flex flex-col gap-3 py-4 pl-3 pr-2 border-r w-60 shrink-0 border-divider"
                >
                    <Input
                        size="sm"
                        aria-label={t`Search the guides`}
                        placeholder={t`Search the guides`}
                        startContent={<SearchIcon className="size-4 text-default-400" />}
                        value={query}
                        onValueChange={setQuery}
                        isClearable={true}
                        onClear={() => setQuery('')}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck="false"
                    />
                    <ScrollShadow className="flex flex-col flex-1 min-h-0 gap-4 pr-1 overflow-y-auto">
                        {!query && (
                            <SidebarItem
                                title={t`All guides`}
                                icon={GraduationCapIcon}
                                tone="graphite"
                                selected={!guide}
                                onPress={() => select(null)}
                            />
                        )}
                        {CATEGORIES.map((category) => {
                            const inside = shown.filter((g) => g.category === category.id)
                            if (inside.length === 0) return null
                            return (
                                <div key={category.id} className="flex flex-col gap-0.5">
                                    <p className="px-2 pb-1 font-medium tracking-wider uppercase text-tiny text-default-500">
                                        {category.title}
                                    </p>
                                    {inside.map((g) => (
                                        <SidebarItem
                                            key={g.id}
                                            title={g.title}
                                            icon={g.icon}
                                            tone={toneOf(g)}
                                            selected={g.id === guide?.id}
                                            onPress={() => select(g.id)}
                                        />
                                    ))}
                                </div>
                            )
                        })}
                        {shown.length === 0 && (
                            <p className="px-2 text-small text-default-500">
                                <Trans>No guide mentions “{term}”.</Trans>
                            </p>
                        )}
                    </ScrollShadow>
                </nav>
                <div
                    ref={content}
                    className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto overscroll-none"
                >
                    {guide ? (
                        <GuideView key={guide.id} guide={guide} onSelect={select} />
                    ) : (
                        <Overview onSelect={select} />
                    )}
                </div>
            </div>
        </KeyboardContext.Provider>
    )
}

function SidebarItem({
    title,
    icon,
    tone,
    selected,
    onPress,
}: {
    title: string
    icon: Guide['icon']
    tone: Tone
    selected: boolean
    onPress: () => void
}) {
    return (
        <button
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={onPress}
            className={cn(
                'flex items-center gap-2.5 px-1.5 py-1.5 text-left rounded-lg text-small outline-none',
                'transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-primary',
                selected
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'text-default-700 hover:bg-default-100'
            )}
        >
            <IconTile icon={icon} tone={tone} size="sm" />
            <span className="leading-snug">{title}</span>
        </button>
    )
}

function Overview({ onSelect }: { onSelect: (id: string) => void }) {
    const os = platform()
    return (
        <article className="flex flex-col max-w-3xl gap-10 px-8 pt-7 pb-12 mx-auto">
            <header className="flex flex-col gap-6">
                <div className="flex flex-col gap-1.5">
                    <h1 className="font-rounded text-[28px] font-semibold leading-tight tracking-tight">
                        <Trans>Guides</Trans>
                    </h1>
                    <p className="text-default-600 text-pretty">
                        <Trans>
                            Short guides to what Rclone UI can do. Their buttons open the windows
                            they talk about.
                        </Trans>
                    </p>
                </div>
                <LauncherDemo />
                <p className="text-small text-default-500 text-pretty">
                    <GuideText
                        text={t`Most things start in the launcher. Press [[shortcut]] in any app and type what you want to do, or click the launcher above to open it.`}
                    />
                </p>
            </header>
            {CATEGORIES.map((category) => {
                const inside = GUIDES.filter(
                    (g) => g.category === category.id && matches(g, '', os)
                )
                if (inside.length === 0) return null
                return (
                    <section key={category.id} className="flex flex-col gap-3">
                        <h2 className="font-semibold tracking-wider uppercase text-tiny text-default-500">
                            {category.title}
                        </h2>
                        <CardGrid guides={inside} onSelect={onSelect} />
                    </section>
                )
            })}
        </article>
    )
}

/**
 * Guides as cards, two to a row in the window's width. A last card left alone in its row takes
 * the whole row.
 */
function CardGrid({ guides, onSelect }: { guides: Guide[]; onSelect: (id: string) => void }) {
    return (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] [&>:last-child:nth-child(odd)]:col-span-full">
            {guides.map((g) => (
                <GuideCard key={g.id} guide={g} onPress={() => onSelect(g.id)} />
            ))}
        </div>
    )
}

function GuideCard({ guide, onPress }: { guide: Guide; onPress: () => void }) {
    return (
        <button
            type="button"
            onClick={onPress}
            className={cn(
                SURFACE,
                'flex items-start gap-3.5 p-4 text-left outline-none',
                'transition-[translate,scale,box-shadow] duration-150 ease-out',
                'hover:-translate-y-0.5 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-primary',
                SURFACE_HOVER
            )}
        >
            <IconTile icon={guide.icon} tone={toneOf(guide)} size="lg" />
            <span className="flex flex-col min-w-0 gap-1">
                <span className="font-medium leading-snug">{guide.title}</span>
                <span className="leading-snug text-small text-default-500 text-pretty">
                    <GuideText text={guide.summary} />
                </span>
            </span>
        </button>
    )
}

function GuideView({ guide, onSelect }: { guide: Guide; onSelect: (id: string) => void }) {
    const os = platform()
    const tone = toneOf(guide)
    const category = CATEGORIES.find((c) => c.id === guide.category)
    const forThisOs = <T extends { os?: string[] }>(items: T[] | undefined) =>
        (items ?? []).filter((item) => !item.os || item.os.includes(os))
    const related = (guide.related ?? []).map(guideById).filter((g): g is Guide => !!g)
    return (
        <article className="flex flex-col max-w-2xl gap-10 px-8 pt-7 pb-12 mx-auto">
            <header className="flex flex-col items-start gap-4">
                <IconTile icon={guide.icon} tone={tone} size="xl" />
                <div className="flex flex-col gap-1">
                    {category && (
                        <p
                            className={cn(
                                'font-semibold tracking-wider uppercase text-tiny',
                                TONE_TEXT[tone]
                            )}
                        >
                            {category.title}
                        </p>
                    )}
                    <h1 className="font-rounded text-[28px] font-semibold leading-tight tracking-tight text-balance">
                        {guide.title}
                    </h1>
                </div>
                <p className="text-medium text-default-600 text-pretty">
                    <GuideText text={guide.summary} />
                </p>
                {guide.open && <OpenButton action={guide.open} primary={true} />}
            </header>
            {forThisOs(guide.sections).map((section) => (
                <section key={section.title} className="flex flex-col gap-4">
                    <h2 className="font-semibold text-large">{section.title}</h2>
                    {section.text?.map((text) => (
                        <p key={text} className="leading-relaxed text-default-700 text-pretty">
                            <GuideText text={text} />
                        </p>
                    ))}
                    {section.steps && (
                        <Steps
                            steps={forThisOs(section.steps)}
                            tone={tone}
                            ownRoute={guide.open?.route}
                        />
                    )}
                    {section.tips?.map((tip) => (
                        <aside
                            key={tip}
                            className="flex gap-3 p-3.5 leading-relaxed rounded-xl bg-warning-50 text-small text-default-700 dark:bg-warning-50/40"
                        >
                            <TipIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                            <span className="text-pretty">
                                <GuideText text={tip} />
                            </span>
                        </aside>
                    ))}
                </section>
            ))}
            {related.length > 0 && (
                <section className="flex flex-col gap-3 pt-8 border-t border-divider">
                    <h2 className="font-semibold tracking-wider uppercase text-tiny text-default-500">
                        <Trans>Read next</Trans>
                    </h2>
                    <CardGrid guides={related} onSelect={onSelect} />
                </section>
            )}
        </article>
    )
}

/**
 * A section's steps. A step's button is left out when it opens the guide's own window, which the
 * header offers.
 */
function Steps({
    steps,
    tone,
    ownRoute,
}: {
    steps: NonNullable<Guide['sections'][number]['steps']>
    tone: Tone
    ownRoute?: string
}) {
    return (
        <ol className="flex flex-col">
            {steps.map((step, index) => (
                <li key={step.text} className="relative flex gap-3.5 pb-5 last:pb-0">
                    {index < steps.length - 1 && (
                        <span
                            aria-hidden={true}
                            className="absolute left-3 top-[30px] bottom-0.5 w-px -translate-x-1/2 bg-default-200"
                        />
                    )}
                    <span
                        className={cn(
                            'grid shrink-0 place-items-center rounded-full bg-linear-to-b text-white size-6',
                            'font-semibold tabular-nums text-tiny',
                            GLOSS,
                            TONE_GRADIENT[tone]
                        )}
                    >
                        {index + 1}
                    </span>
                    <div className="flex flex-col items-start gap-2 pt-px leading-relaxed text-default-700 text-pretty">
                        <span>
                            <GuideText text={step.text} />
                        </span>
                        {step.action && step.action.route !== ownRoute && (
                            <OpenButton action={step.action} />
                        )}
                    </div>
                </li>
            ))}
        </ol>
    )
}

function OpenButton({ action, primary }: { action: Action; primary?: boolean }) {
    return (
        <Button
            size="sm"
            color="primary"
            variant={primary ? 'solid' : 'flat'}
            endContent={<ArrowRightSmallIcon className="size-4" />}
            onPress={() => openWindow(action.route)}
        >
            {action.label}
        </Button>
    )
}
