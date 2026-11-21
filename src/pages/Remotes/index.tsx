import { useAutoAnimate } from '@formkit/auto-animate/react'
import { Button, cn, Input, Tab, Tabs, Tooltip } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
    ArrowsRotate as ArrowsRotateIcon,
    Cloud as CloudIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    FileText as FileTextIcon,
    Plus as PlusIcon,
    Search as SearchIcon,
} from '@zappicon/react'
import {
    startTransition,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { ConfigStatus, useConfig } from '../../../lib/configs'
import { formatErrorMessage, onErrorDialog } from '../../../lib/errors'
import { compareText, foldCase, formatNumber } from '../../../lib/format'
import {
    deleteRemote,
    namesOf,
    recheckRemotes,
    useRemoteHealth,
    useRemotes,
} from '../../../lib/remotes'
import { ask, message } from '../../../lib/shell'
import Alert from '../../components/Alert'
import { BackendTile, backendLabel } from '../../components/BackendIcon'
import EmptyState from '../../components/EmptyState'
import { SEARCH_FROM } from '../../components/list/list'
import { toneButton } from '../../components/look/buttons'
import SettingsWindow from '../../components/SettingsWindow'
import { usePageQuery } from '../../route'
import { WINDOWS } from '../../routes'
import ConfigDrawer from './Config/ConfigDrawer'
import { CARD_HEIGHT, RemoteCard, RemoteCardSkeleton } from './RemoteCard'
import RemoteCreateDrawer, { POPULAR } from './RemoteCreateDrawer'
import RemoteEditDrawer from './RemoteEditDrawer'
import { RemotesSummary } from './RemotesSummary'
import { needsAttention, summarize } from './usage'

const LOOK = WINDOWS.remotes

const CARD_GAP = 10
const REMOTE_ROW_SIZE = CARD_HEIGHT + CARD_GAP
const SECTION_HEADER_SIZE = 36

type RemoteRow = { type: 'header'; key: string } | { type: 'remote'; remote: string }

function sectionKeyFor(name: string): string {
    const first = name[0]?.toUpperCase() ?? '#'
    if (first >= 'A' && first <= 'Z') return first
    if (first >= '0' && first <= '9') return '0-9'
    return '#'
}

function sectionRank(key: string): number {
    if (key === '#') return 0
    if (key === '0-9') return 1
    return 2
}

// Splits the remotes into sections, with a header row before each. `remotes` must already be
// sorted, because each section keeps the incoming order.
function buildRemoteRows(remotes: string[]): RemoteRow[] {
    const buckets = new Map<string, string[]>()
    for (const remote of remotes) {
        const key = sectionKeyFor(remote)
        const bucket = buckets.get(key)
        if (bucket) bucket.push(remote)
        else buckets.set(key, [remote])
    }

    const orderedKeys = [...buckets.keys()].sort((a, b) => {
        const rank = sectionRank(a) - sectionRank(b)
        return rank === 0 ? compareText(a, b) : rank
    })

    const rows: RemoteRow[] = []
    for (const key of orderedKeys) {
        rows.push({ type: 'header', key })
        for (const remote of buckets.get(key) ?? []) {
            rows.push({ type: 'remote', remote })
        }
    }
    return rows
}

function newRemoteOf(type: string): string {
    const backend = backendLabel(type)
    return t`New ${backend} remote`
}

export default function Remotes() {
    const searchParams = usePageQuery()

    const [editingDrawerOpen, setEditingDrawerOpen] = useState(false)
    const [creatingDrawerOpen, setCreatingDrawerOpen] = useState(false)
    // The type that a new remote starts with, when it was picked in the empty window.
    const [creatingType, setCreatingType] = useState<string>()
    const [configDrawerOpen, setConfigDrawerOpen] = useState(false)

    // When rclone can't read the config file, the reason shows above the list.
    const configQuery = useConfig()
    const config = configQuery.data ?? null
    const unreadable =
        config?.status === ConfigStatus.StatusError
            ? config.message || t`Rclone could not read the config file.`
            : undefined

    // remotes.changed and remotes.health keep both queries up to date.
    const { remotes: remoteList, query: remotesQuery } = useRemotes()
    const healthQuery = useRemoteHealth()
    const health = healthQuery.data

    const types = useMemo(
        () => Object.fromEntries(remoteList.map((r) => [r.name, r.type])),
        [remoteList]
    )
    const remotes = useMemo(() => namesOf(remoteList), [remoteList])
    const summary = useMemo(() => summarize(remotes, health), [remotes, health])
    const problems = summary.failing + summary.noAnswer

    const [searchQuery, setSearchQuery] = useState('')
    // "Needs attention" shows only the remotes whose check found a problem. It is offered only
    // while there are some.
    const [onlyProblems, setOnlyProblems] = useState(false)
    const showingProblems = onlyProblems && problems > 0

    // The refresh button spins while the health checks run, the ones it started and the first
    // ones alike.
    const [refreshing, setRefreshing] = useState(false)
    const checking = refreshing || remotes.some((r) => health?.[r]?.state === 'checking')
    const refresh = async () => {
        setRefreshing(true)
        try {
            // Runs the health check on every remote again. The list itself already follows the
            // config file.
            try {
                await recheckRemotes()
            } catch (error) {
                await message(formatErrorMessage(error), {
                    title: t`Couldn't check the remotes`,
                    kind: 'error',
                })
            }
            await Promise.all([remotesQuery.refetch(), healthQuery.refetch()])
        } finally {
            setRefreshing(false)
        }
    }
    const openCreate = (type?: string) => {
        setCreatingType(type)
        setTimeout(() => setCreatingDrawerOpen(true), 100)
    }

    const filteredRemotes = useMemo(() => {
        const query = foldCase(searchQuery)
        return remotes.filter(
            (r) =>
                (!query || foldCase(r).includes(query)) &&
                (!showingProblems || needsAttention(health?.[r]))
        )
    }, [remotes, searchQuery, showingProblems, health])

    // The remotes list is virtualized, and scrolls with the window under the summary. Each card
    // has a fixed height with a gap under it. Section headers are shorter.
    const scrollRef = useRef<HTMLDivElement>(null)
    // Where the list starts in the scrolling content, under the summary and any alert.
    const listStart = useRef<HTMLDivElement>(null)
    const [scrollMargin, setScrollMargin] = useState(0)
    useLayoutEffect(() => {
        const top = listStart.current?.offsetTop ?? 0
        if (top !== scrollMargin) setScrollMargin(top)
    })

    const showSections = filteredRemotes.length > 10

    const rows = useMemo<RemoteRow[]>(
        () =>
            showSections
                ? buildRemoteRows(filteredRemotes)
                : filteredRemotes.map((remote) => ({ type: 'remote', remote })),
        [filteredRemotes, showSections]
    )

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: (index) =>
            rows[index].type === 'header' ? SECTION_HEADER_SIZE : REMOTE_ROW_SIZE,
        overscan: 6,
        scrollMargin,
    })

    // The list animates in only the first time it appears. The rows are held back until the
    // scroll element has a size, and they animate in as they are added. Afterwards, auto-animate
    // is switched off, so scrolling (which mounts and unmounts rows) and later edits are instant.
    const [animateListRef, setListAnimated] = useAutoAnimate()
    const listEl = useRef<HTMLDivElement | null>(null)
    // The callback must stay the same between renders. A new callback on each render would
    // attach the ref again (null, then el) every time. auto-animate's ref sets state, so that
    // would cause an endless render loop.
    const listRef = useCallback(
        (el: HTMLDivElement | null) => {
            listEl.current = el
            animateListRef(el)
        },
        [animateListRef]
    )
    const listVisible = (rowVirtualizer.scrollRect?.height ?? 0) > 0
    // auto-animate also animates the list container itself on every change (FLIP), starting
    // from the position it last measured. If it were attached while the list is hidden, it
    // would record a 0×0 rect, and on the first change it would slide the whole list in from the
    // corner. So it is attached only once the list is visible, and the rows are added one commit
    // later. auto-animate needs to see that change to animate the rows in.
    const [rowsReady, setRowsReady] = useState(false)
    useEffect(() => {
        if (listVisible) setRowsReady(true)
    }, [listVisible])
    const virtualItems = listVisible && rowsReady ? rowVirtualizer.getVirtualItems() : []
    const hasAnimatedIn = useRef(false)
    useEffect(() => {
        if (hasAnimatedIn.current || virtualItems.length === 0) return
        hasAnimatedIn.current = true
        let cancelled = false
        // Disabling auto-animate cancels running animations. Its mutation observer creates the
        // entrance animations a microtask after this commit, so wait for them to finish before
        // switching it off.
        const id = setTimeout(async () => {
            const entrances = listEl.current?.getAnimations({ subtree: true }) ?? []
            await Promise.allSettled(entrances.map((animation) => animation.finished))
            if (!cancelled) setListAnimated(false)
        }, 0)
        return () => {
            cancelled = true
            clearTimeout(id)
        }
    }, [virtualItems.length, setListAnimated])

    const [pickedRemote, setPickedRemote] = useState<string | null>(null)
    const edit = (remote: string) =>
        startTransition(() => {
            setPickedRemote(remote)
            setEditingDrawerOpen(true)
        })

    const deleteRemoteMutation = useMutation({
        mutationFn: async (remote: string) => {
            await deleteRemote(remote)
            return remote
        },
        onError: onErrorDialog(t`Could not delete remote`, t`Unknown error occurred`, {
            log: ['Failed to delete remote:'],
        }),
    })
    const confirmDelete = async (remote: string) => {
        const confirmation = await ask(
            t`Delete ${remote}? The connection settings are removed. The files stored on it stay where they are.`,
            {
                title: t`Delete ${remote}`,
                kind: 'warning',
                destructive: true,
                okLabel: t`Delete remote`,
                cancelLabel: t({
                    message: 'Keep it',
                    comment: 'Button: keeps the remote instead of deleting it.',
                }),
            }
        )
        if (confirmation) deleteRemoteMutation.mutate(remote)
    }

    useEffect(() => {
        const action = searchParams.get('action')
        const remote = searchParams.get('remote')

        if (action === 'create') {
            startTransition(() => {
                setCreatingDrawerOpen(true)
            })
        } else if (action === 'edit' && remote) {
            startTransition(() => {
                setPickedRemote(remote)
                setEditingDrawerOpen(true)
            })
        }
    }, [searchParams])

    const newRemote = (
        <Button
            color="primary"
            className={toneButton(LOOK.tone)}
            startContent={<PlusIcon className="size-4" />}
            onPress={() => openCreate()}
            data-focus-visible="false"
        >
            <Trans>New remote</Trans>
        </Button>
    )

    const isEmpty =
        !remotesQuery.isLoading &&
        !remotesQuery.isError &&
        remotes.length === 0 &&
        !unreadable &&
        !creatingDrawerOpen

    // What the window shows instead of the list. For an unreadable config it is an empty element,
    // because the alert above the list says why.
    const placeholder = remotesQuery.isLoading ? (
        <div aria-busy={true} aria-label={t`Loading the remotes`} className="flex flex-col gap-2.5">
            {[0, 1, 2, 3].map((i) => (
                <RemoteCardSkeleton key={i} />
            ))}
        </div>
    ) : remotesQuery.isError ? (
        <EmptyState
            icon={ExclamationTriangleIcon}
            tone="red"
            title={t`Couldn't load the remotes`}
            description={formatErrorMessage(remotesQuery.error)}
            className="min-h-[50vh]"
            actions={
                <Button
                    onPress={() => remotesQuery.refetch()}
                    isLoading={remotesQuery.isFetching}
                    variant="flat"
                    data-focus-visible="false"
                >
                    <Trans>Retry</Trans>
                </Button>
            }
        />
    ) : remotes.length === 0 && unreadable ? (
        <div />
    ) : isEmpty ? (
        <EmptyState
            icon={CloudIcon}
            tone={LOOK.tone}
            title={t`No remotes yet`}
            description={t`A remote is storage you connect once: a cloud drive, a bucket or a server. Then you browse, copy, sync and mount it from here.`}
            className="min-h-[calc(100dvh-12rem)] py-6"
            actions={newRemote}
        >
            <div className="flex flex-col items-center gap-3">
                <p className="text-xs text-default-500">
                    <Trans>Or start with one of these</Trans>
                </p>
                <ul className="flex flex-wrap justify-center gap-2">
                    {POPULAR.map((type) => (
                        <li key={type}>
                            <Tooltip
                                content={backendLabel(type)}
                                color="foreground"
                                delay={300}
                                closeDelay={0}
                            >
                                <button
                                    type="button"
                                    aria-label={newRemoteOf(type)}
                                    onClick={() => openCreate(type)}
                                    className="block rounded-[14px] outline-none transition-[translate,scale] duration-150 ease-out hover:-translate-y-0.5 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                                >
                                    <BackendTile type={type} size="xl" />
                                </button>
                            </Tooltip>
                        </li>
                    ))}
                </ul>
            </div>
        </EmptyState>
    ) : null

    const hasList = !placeholder

    return (
        <SettingsWindow
            look={LOOK}
            description={t`Your connected storage, and how full it is.`}
            scrollRef={scrollRef}
            className="flex flex-col gap-4"
            actions={
                <>
                    <Tooltip content={t`Check every remote again`} color="foreground">
                        <Button
                            onPress={refresh}
                            isIconOnly={true}
                            variant="flat"
                            aria-label={t`Check every remote again`}
                            data-focus-visible="false"
                            isDisabled={refreshing}
                        >
                            <ArrowsRotateIcon
                                className={cn(
                                    'size-4',
                                    checking && 'animate-spin motion-reduce:animate-none'
                                )}
                            />
                        </Button>
                    </Tooltip>
                    <Button
                        onPress={() => setConfigDrawerOpen(true)}
                        variant="flat"
                        data-focus-visible="false"
                        isDisabled={!config}
                        startContent={<FileTextIcon className="size-4" />}
                    >
                        <Trans>Config file</Trans>
                    </Button>
                    {!isEmpty && newRemote}
                </>
            }
            toolbar={
                hasList &&
                (remotes.length > SEARCH_FROM || problems > 0) && (
                    <div className="flex flex-row items-center gap-3">
                        {remotes.length > SEARCH_FROM && (
                            <Input
                                aria-label={t`Search remotes`}
                                placeholder={t`Search remotes`}
                                value={searchQuery}
                                onValueChange={setSearchQuery}
                                startContent={
                                    <SearchIcon className="size-4 shrink-0 text-default-400" />
                                }
                                isClearable={true}
                                onClear={() => setSearchQuery('')}
                                data-focus-visible="false"
                                className="max-w-xs"
                                autoCapitalize="off"
                                autoComplete="off"
                                autoCorrect="off"
                                spellCheck="false"
                            />
                        )}
                        {problems > 0 && (
                            <Tabs
                                aria-label={t`Which remotes to show`}
                                size="sm"
                                radius="md"
                                selectedKey={showingProblems ? 'problems' : 'all'}
                                onSelectionChange={(key) => setOnlyProblems(key === 'problems')}
                                classNames={{
                                    tabList: 'p-1 gap-1',
                                    tab: 'h-7 px-3',
                                    panel: 'hidden',
                                }}
                                className="ms-auto"
                            >
                                <Tab
                                    key="all"
                                    title={
                                        <span className="flex items-center gap-1.5 tabular-nums">
                                            {t({
                                                message: 'All',
                                                comment:
                                                    'Tab: shows every remote. A count follows.',
                                            })}
                                            <span className="text-default-500">
                                                {formatNumber(remotes.length)}
                                            </span>
                                        </span>
                                    }
                                />
                                <Tab
                                    key="problems"
                                    title={
                                        <span className="flex items-center gap-1.5 tabular-nums">
                                            {t({
                                                message: 'Needs attention',
                                                comment:
                                                    'Tab: shows only the remotes whose check found a problem. A count follows.',
                                            })}
                                            <span className="grid h-4 px-1.5 text-white rounded-full place-items-center text-[10px] font-semibold bg-danger min-w-4">
                                                {formatNumber(problems)}
                                            </span>
                                        </span>
                                    }
                                />
                            </Tabs>
                        )}
                    </div>
                )
            }
        >
            {unreadable && (
                <Alert color="danger" variant="faded" title={t`The remotes could not be read`}>
                    <p className="text-small [overflow-wrap:anywhere]">{unreadable}</p>
                </Alert>
            )}

            {placeholder}

            {hasList && remotes.length > 1 && !searchQuery && !showingProblems && (
                <RemotesSummary summary={summary} onShowProblems={() => setOnlyProblems(true)} />
            )}

            {hasList && filteredRemotes.length === 0 && searchQuery && (
                <EmptyState
                    icon={SearchIcon}
                    tone={LOOK.tone}
                    title={t`No remotes match`}
                    description={t`No remote is named like “${searchQuery}”.`}
                    className="min-h-[50vh]"
                    actions={
                        <Button
                            variant="flat"
                            onPress={() => setSearchQuery('')}
                            data-focus-visible="false"
                        >
                            <Trans>Clear search</Trans>
                        </Button>
                    }
                />
            )}

            <div ref={listStart} className={cn(filteredRemotes.length === 0 && 'hidden')}>
                <div
                    ref={listVisible ? listRef : undefined}
                    style={{
                        height: `${rowVirtualizer.getTotalSize()}px`,
                        position: 'relative',
                        width: '100%',
                    }}
                >
                    {virtualItems.map((virtualRow) => {
                        const row = rows[virtualRow.index]
                        // Position rows with `top` rather than translateY, because the entrance
                        // animation sets `transform` and would override it.
                        const style = {
                            position: 'absolute',
                            top: `${virtualRow.start - scrollMargin}px`,
                            left: 0,
                            width: '100%',
                            height: `${virtualRow.size}px`,
                        } as const

                        if (row.type === 'header') {
                            return (
                                <div key={`h-${row.key}`} style={style}>
                                    <div className="flex items-end h-full px-1 pb-2">
                                        <span className="text-xs font-semibold tracking-wide uppercase text-default-400">
                                            {row.key}
                                        </span>
                                    </div>
                                </div>
                            )
                        }

                        const remote = row.remote
                        return (
                            <div key={`r-${remote}`} style={style}>
                                <RemoteCard
                                    remote={remote}
                                    type={types[remote]}
                                    health={health?.[remote]}
                                    tone={summary.tones[remote]}
                                    onEdit={() => edit(remote)}
                                    onDelete={() => confirmDelete(remote)}
                                />
                            </div>
                        )
                    })}
                </div>
            </div>

            {pickedRemote && (
                <RemoteEditDrawer
                    isOpen={editingDrawerOpen}
                    onClose={() => {
                        setEditingDrawerOpen(false)
                        setTimeout(() => {
                            // Wait for the drawer to slide out.
                            setPickedRemote(null)
                        }, 100)
                    }}
                    remoteName={pickedRemote}
                />
            )}

            <ConfigDrawer
                isOpen={configDrawerOpen}
                onClose={() => setConfigDrawerOpen(false)}
                config={config}
            />

            <RemoteCreateDrawer
                isOpen={creatingDrawerOpen}
                type={creatingType}
                onClose={() => {
                    startTransition(() => {
                        setCreatingDrawerOpen(false)
                    })
                }}
            />
        </SettingsWindow>
    )
}
