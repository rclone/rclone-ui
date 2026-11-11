import { Button, cn, Input, Skeleton, Tooltip } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import type { UseQueryResult } from '@tanstack/react-query'
import { Search as SearchIcon } from '@zappicon/react'
import { AnimatePresence, type HTMLMotionProps, motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'
import { formatErrorMessage } from '../../../lib/errors'
import { formatNumber } from '../../../lib/format'
import { platform } from '../../../lib/shell'
import { WINDOWS, type WindowLook } from '../../routes'
import EmptyState from '../EmptyState'
import { Panel } from '../look/Panel'
import { StatusDot, type StatusKind } from '../look/Status'
import { GLOSS, TONE_GRADIENT, type Tone } from '../look/tones'
import { WindowHeader } from '../look/WindowHeader'
import { useListSearch } from './list'

// The window that the Schedules, Watchers and Automounts windows share (ListWindow). Its parts are
// exported for the windows that lay out their own list: Templates uses the search and the states,
// and the Notifications window's rows use the same status column.

const NONE: never[] = []

interface ListWords {
    loadFailed: string
    search: string
    noMatch: string
}

/** A window that isn't listed here gets texts that don't name its things. */
function listWords(look: WindowLook): ListWords {
    switch (look) {
        case WINDOWS.schedules:
            return {
                loadFailed: t`Couldn't load the schedules`,
                search: t`Search schedules`,
                noMatch: t`No schedules match`,
            }
        case WINDOWS.watchers:
            return {
                loadFailed: t`Couldn't load the watchers`,
                search: t`Search watchers`,
                noMatch: t`No watchers match`,
            }
        case WINDOWS.automounts:
            return {
                loadFailed: t`Couldn't load the automounts`,
                search: t`Search automounts`,
                noMatch: t`No automounts match`,
            }
        default:
            return {
                loadFailed: t`Couldn't load the list`,
                search: t({ message: 'Search', comment: 'The placeholder of a search field.' }),
                noMatch: t`Nothing matches`,
            }
    }
}

/**
 * A list window. It shows a skeleton while the list loads, the error and Retry when the load
 * fails, and `empty` with its steps and `action` when the list is empty. Otherwise it shows the
 * header, a search field once the list is long (SEARCH_FROM), then `notice` and the rows.
 * `drawers` are rendered in every state, so that a drawer stays open while the list reloads.
 */
export function ListWindow<T extends { id: string }>({
    look,
    query,
    fields,
    summary,
    action,
    empty,
    notice,
    noMatch,
    row,
    drawers,
}: {
    look: WindowLook
    query: UseQueryResult<T[]>
    /** The texts of an item that the search looks in. The same function on every render. */
    fields: (t: T) => string[]
    /** The line under the window's title. */
    summary: ReactNode
    /** The button that makes a new thing. */
    action: ReactNode
    empty: { title: string; description: string; steps: readonly string[] }
    notice?: ReactNode
    /** Says why nothing matches the search, which is passed trimmed. Shown under "No … match". */
    noMatch: (search: string) => string
    row: (t: T) => ReactNode
    drawers: ReactNode
}) {
    // A core that returns no list sends null.
    const items: readonly T[] = query.data ?? NONE
    const { search, setSearch, searching, shown } = useListSearch(items, fields)
    const rowMotion = useRowMotion()
    const page = pageClass(platform() === 'macos')
    const words = listWords(look)

    if (query.isError) {
        return (
            <div className={page}>
                <LoadError
                    look={look}
                    title={words.loadFailed}
                    error={query.error}
                    retrying={query.isFetching}
                    onRetry={() => query.refetch()}
                />
                {drawers}
            </div>
        )
    }

    if (query.isLoading) {
        return (
            <div className={page}>
                <ListSkeleton />
                {drawers}
            </div>
        )
    }

    if (items.length === 0) {
        return (
            <div className={page}>
                <EmptyState
                    icon={look.icon}
                    tone={look.tone}
                    title={empty.title}
                    description={empty.description}
                    className="flex-1"
                    actions={action}
                >
                    <Steps steps={empty.steps} tone={look.tone} />
                </EmptyState>
                {drawers}
            </div>
        )
    }

    return (
        <div className={page}>
            <div className="relative flex flex-col gap-4 px-6 pt-5 pb-4 shrink-0">
                <WindowHeader
                    look={look}
                    description={<span className="tabular-nums">{summary}</span>}
                    actions={action}
                />
                {searching && (
                    <SearchField label={words.search} value={search} onValueChange={setSearch} />
                )}
            </div>
            {notice}

            {shown.length === 0 ? (
                <NoMatch
                    look={look}
                    title={words.noMatch}
                    description={noMatch(search.trim())}
                    onClear={() => setSearch('')}
                />
            ) : (
                <div className="flex-1 min-h-0 px-6 pt-1 pb-10 overflow-y-auto">
                    <ListPanel label={look.title}>
                        <AnimatePresence initial={false}>
                            {shown.map((item) => (
                                <motion.li key={item.id} {...rowMotion} className="overflow-hidden">
                                    {row(item)}
                                </motion.li>
                            ))}
                        </AnimatePresence>
                    </ListPanel>
                </div>
            )}
            {drawers}
        </div>
    )
}

/** The two lines of a row's text: the name or the status word, and a detail under it. */
export const ROW_LINE_1 = 'leading-5 truncate'
export const ROW_LINE_2 = 'text-xs leading-4 truncate text-default-500 tabular-nums'

/**
 * The status column of a row: a dot and its word, and under them `when` and `note` ("2 minutes
 * ago · Nothing to do"). With `onOpen`, it is a button, and `openTip` is its tooltip.
 */
export function RowStatus({
    kind,
    label,
    when,
    note,
    onOpen,
    openTip,
    id,
}: {
    kind: StatusKind
    label: string
    when?: string
    note?: string
    onOpen?: () => void
    openTip?: string
    id?: string
}) {
    const detail = [when, note].filter(Boolean).join(' · ')
    const body = (
        <>
            <span className={cn('flex items-center gap-2 font-medium text-small', ROW_LINE_1)}>
                <StatusDot kind={kind} />
                <span className="truncate">{label}</span>
            </span>
            {detail && <span className={cn('pl-4', ROW_LINE_2)}>{detail}</span>}
        </>
    )
    return (
        <span className="flex w-40 min-w-0 shrink-0 @2xl:w-56">
            {onOpen ? (
                <Tooltip content={openTip} color="foreground" delay={300}>
                    <button
                        id={id}
                        type="button"
                        onClick={onOpen}
                        className="flex flex-col min-w-0 max-w-full gap-0.5 px-2 py-1 -mx-2 -my-1 text-left rounded-lg outline-none transition-colors duration-150 ease-out hover:bg-default-100 focus-visible:ring-2 focus-visible:ring-primary"
                    >
                        {body}
                    </button>
                </Tooltip>
            ) : (
                <span id={id} className="flex flex-col min-w-0 gap-0.5">
                    {body}
                </span>
            )}
        </span>
    )
}

/** The page around a list window. On macOS it leaves room for the traffic lights. */
export function pageClass(macos: boolean) {
    return cn('relative flex flex-col h-screen', macos && 'pt-7')
}

/**
 * How a row enters and leaves the list. Rows that are there when the list loads don't animate
 * (AnimatePresence initial={false}).
 */
export function useRowMotion(): HTMLMotionProps<'li'> {
    const reduced = useReducedMotion()
    return {
        initial: { opacity: 0, height: 0 },
        animate: { opacity: 1, height: 'auto' },
        exit: { opacity: 0, height: 0 },
        transition: reduced ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.3 },
    }
}

/** The panel that holds a list's rows. It is a `@container`, so rows lay out by its width. */
export function ListPanel({ label, children }: { label: string; children: ReactNode }) {
    return (
        <Panel className="@container">
            <ul aria-label={label} className="flex flex-col divide-y divide-divider">
                {children}
            </ul>
        </Panel>
    )
}

export function SearchField({
    label,
    value,
    onValueChange,
}: {
    label: string
    value: string
    onValueChange: (value: string) => void
}) {
    return (
        <Input
            aria-label={label}
            placeholder={label}
            value={value}
            onValueChange={onValueChange}
            isClearable={true}
            onClear={() => onValueChange('')}
            startContent={<SearchIcon className="size-4 shrink-0 text-default-400" />}
            className="max-w-sm"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck="false"
        />
    )
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
    return (
        <div aria-busy={true} aria-label={t`Loading`} className="flex flex-col gap-5 px-6 pt-5">
            <div className="flex items-center gap-3.5">
                <Skeleton className="size-12 rounded-[14px]" />
                <div className="flex flex-col gap-2">
                    <Skeleton className="w-40 h-5 rounded-md" />
                    <Skeleton className="h-3.5 rounded-md w-72" />
                </div>
            </div>
            <Panel className="flex flex-col divide-y divide-divider">
                {Array.from({ length: rows }, (_, i) => (
                    <div key={i} className="flex items-center gap-3.5 py-4 pl-4 pr-3">
                        <Skeleton className="size-9 rounded-[10px]" />
                        <div className="flex flex-col flex-1 gap-2">
                            <Skeleton className="w-48 h-4 rounded-md" />
                            <Skeleton className="w-64 h-3 rounded-md" />
                        </div>
                        <Skeleton className="w-24 h-4 rounded-md" />
                        <Skeleton className="w-10 h-6 rounded-full" />
                    </div>
                ))}
            </Panel>
        </div>
    )
}

export function LoadError({
    look,
    title,
    error,
    retrying,
    onRetry,
}: {
    look: WindowLook
    title: string
    error: unknown
    retrying: boolean
    onRetry: () => void
}) {
    return (
        <EmptyState
            icon={look.icon}
            tone={look.tone}
            title={title}
            description={formatErrorMessage(error)}
            className="flex-1"
            actions={
                <Button onPress={onRetry} isLoading={retrying} variant="flat">
                    <Trans>Retry</Trans>
                </Button>
            }
        />
    )
}

export function NoMatch({
    look,
    title,
    description,
    onClear,
}: {
    look: WindowLook
    title: string
    description: string
    onClear: () => void
}) {
    return (
        <EmptyState
            icon={SearchIcon}
            tone={look.tone}
            title={title}
            description={description}
            className="flex-1 min-h-0"
            actions={
                <Button variant="flat" onPress={onClear}>
                    <Trans>Clear search</Trans>
                </Button>
            }
        />
    )
}

/** The three steps under a window's empty state, which say how its things work. */
export function Steps({ steps, tone }: { steps: readonly string[]; tone: Tone }) {
    return (
        <ol className="grid gap-3 text-left sm:grid-cols-3">
            {steps.map((step, i) => (
                <li
                    key={step}
                    className="flex flex-col gap-2.5 p-3.5 rounded-2xl bg-default-100/60"
                >
                    <span
                        className={cn(
                            'grid font-semibold text-white rounded-full size-6 place-items-center bg-linear-to-b text-tiny tabular-nums',
                            GLOSS,
                            TONE_GRADIENT[tone]
                        )}
                    >
                        {formatNumber(i + 1)}
                    </span>
                    <span className="leading-snug text-small text-default-600 text-pretty">
                        {step}
                    </span>
                </li>
            ))}
        </ol>
    )
}
