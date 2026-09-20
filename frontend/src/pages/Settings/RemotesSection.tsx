import { useAutoAnimate } from '@formkit/auto-animate/react'
import {
    Button,
    Card,
    CardBody,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Input,
    Spinner,
} from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'

import {
    CableIcon,
    FileTextIcon,
    PencilIcon,
    PlusIcon,
    RefreshCcwIcon,
    SearchIcon,
    SettingsIcon,
    Trash2Icon,
} from 'lucide-react'
import {
    type ReactNode,
    startTransition,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { onErrorDialog } from '../../../lib/errors'
import { formatBytes } from '../../../lib/format'
import { remoteConfigQueryOptions } from '../../../lib/hooks'
import { forgetRemoteHealth, remoteHealthQueryOptions } from '../../../lib/rclone/health'
import { mountSupportQueryOptions } from '../../../lib/rclone/mount'
import rclone from '../../../lib/rclone/client'
import ConfigEditDrawer from '../../components/ConfigEditDrawer'
import RemoteAutoMountDrawer from '../../components/RemoteAutoMountDrawer'
import RemoteCreateDrawer from '../../components/RemoteCreateDrawer'
import RemoteEditDrawer from '../../components/RemoteEditDrawer'
import BaseSection from './BaseSection'
import { ask } from '../../../lib/api/dialog'

const REMOTE_ROW_SIZE = 90
const SECTION_HEADER_SIZE = 36

type RemoteRow = { type: 'header'; key: string } | { type: 'remote'; remote: string }

// Section a remote falls under. Letters group by their uppercase initial; digits collapse into '0-9'
// and everything else into '#', both of which sort ahead of A–Z.
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

// Groups the (already alphabetically sorted) remotes into '#' / '0-9' / A–Z sections, emitting a header
// row before each run. Buckets keep their incoming order, so remotes stay sorted within a section.
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
        return rank !== 0 ? rank : a.localeCompare(b)
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

export default function RemotesSection() {
    const queryClient = useQueryClient()
    const [searchParams] = useSearchParams()
    const [editingDrawerOpen, setEditingDrawerOpen] = useState(false)
    const [creatingDrawerOpen, setCreatingDrawerOpen] = useState(false)
    // The editor on rclone's config file, read and written through the daemon.
    const [configDrawerOpen, setConfigDrawerOpen] = useState(false)
    const [autoMountDrawerOpen, setAutoMountDrawerOpen] = useState(false)

    const remotesQuery = useQuery({
        queryKey: ['remotes', 'list', 'all'],
        queryFn: async () => await rclone('/config/listremotes').then((r) => r?.remotes),
        staleTime: 1000 * 60, // 1 minute
        enabled: !editingDrawerOpen && !creatingDrawerOpen && !autoMountDrawerOpen,
    })

    const remotes = useMemo(() => remotesQuery.data ?? [], [remotesQuery.data])

    const sortedRemotes = useMemo(() => [...remotes].sort((a, b) => a.localeCompare(b)), [remotes])

    const [searchQuery, setSearchQuery] = useState('')

    const filteredRemotes = useMemo(
        () =>
            searchQuery
                ? sortedRemotes.filter((r) => r.toLowerCase().includes(searchQuery.toLowerCase()))
                : sortedRemotes,
        [sortedRemotes, searchQuery]
    )

    // Virtualize the remotes list: each RemoteCard is a fixed-height (h-20 = 80px) card with a
    // gap-2.5 (10px) between rows, so a row slot is 90px. Section headers are shorter. Each card also
    // fires its own queries, so windowing keeps a long list from mounting every card (and its request
    // fan-out) at once.
    const scrollRef = useRef<HTMLDivElement>(null)

    // Past 10 remotes, break the list into '#' / '0-9' / A–Z sections (a bare letter row, no box).
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
    })

    // Entrance animation for the list's first appearance only. Inactive tab
    // panels are display:none, so the scroll element measures 0 until the
    // Remotes tab is shown; rows are held back until then, animate in as they
    // are added, and auto-animate is switched off afterwards so scrolling
    // (rows mounting/unmounting) and later edits stay instant.
    const [animateListRef, setListAnimated] = useAutoAnimate()
    const listEl = useRef<HTMLDivElement | null>(null)
    // Stable identity: a fresh callback each render would re-attach the ref
    // (null → el) every time, and auto-animate's ref sets state → render loop.
    const listRef = useCallback(
        (el: HTMLDivElement | null) => {
            listEl.current = el
            animateListRef(el)
        },
        [animateListRef]
    )
    const listVisible = (rowVirtualizer.scrollRect?.height ?? 0) > 0
    // auto-animate also FLIP-animates the list container itself on every
    // mutation, from the position it last measured. Attached while the panel
    // is hidden it would cache a 0×0 rect and, on the first mutation, slide the
    // whole list in from the panel's corner. So the controller is attached
    // only once the list is visible, and the rows are added one commit later —
    // the mutation auto-animate needs to see for the rows' entrance.
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
        // Disabling cancels in-flight animations, so wait for the entrance
        // animations (created by auto-animate's mutation observer, a
        // microtask after this commit) to finish before switching it off.
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

    // A drawer stays mounted while it slides shut, so the remote it shows is not cleared on
    // close. Each drawer keeps its own, or opening one would mount the other; `opening` counts
    // openings and keys them, so every opening seeds a fresh form.
    const [editRemote, setEditRemote] = useState<string | null>(null)
    const [mountRemote, setMountRemote] = useState<string | null>(null)
    const [opening, setOpening] = useState(0)

    const deleteRemoteMutation = useMutation({
        mutationFn: async (remote: string) => {
            await rclone('/config/delete', {
                params: {
                    query: {
                        name: remote,
                    },
                },
            })

            return remote
        },
        onSuccess: async (remote) => {
            // A wrapper over the deleted remote keeps answering from rclone's cache until then.
            await rclone('/fscache/clear').catch(() => null)
            forgetRemoteHealth()
            queryClient.setQueryData(['remotes', 'list', 'all'], (old: string[] | undefined) => [
                ...(old ?? []).filter((r) => r !== remote),
            ])
        },
        onError: onErrorDialog('Could not delete remote', 'Unknown error occurred', {
            log: ['Failed to delete remote:'],
        }),
    })

    const Placeholder = useMemo(() => {
        const withRoot = (element: ReactNode) => {
            return (
                <div className="flex flex-col px-4 justify-center items-center h-[calc(100dvh-14rem)]">
                    {element}
                </div>
            )
        }

        if (remotesQuery.isLoading || remotesQuery.isRefetching) {
            return withRoot(<Spinner size="lg" color="primary" className="scale-150" />)
        }

        if (remotes.length === 0 && !creatingDrawerOpen) {
            return withRoot(
                <div className="flex flex-col items-center justify-center gap-8">
                    <h1 className="text-2xl font-bold">Add your first remote!</h1>
                    <Button
                        onPress={() => setCreatingDrawerOpen(true)}
                        color="primary"
                        data-focus-visible="false"
                        variant="shadow"
                        size="lg"
                    >
                        Create Remote
                    </Button>
                </div>
            )
        }

        return null
    }, [remotesQuery.isLoading, remotesQuery.isRefetching, remotes.length, creatingDrawerOpen])

    // `/remotes?action=create` (the Dashboard's getting-started step) opens the create drawer.
    useEffect(() => {
        if (searchParams.get('action') === 'create') {
            startTransition(() => {
                setCreatingDrawerOpen(true)
            })
        }
    }, [searchParams])

    return (
        <BaseSection
            header={{
                title: 'Remotes',
                endContent: (
                    <div className="flex flex-row items-center gap-2">
                        <Button
                            onPress={() => setConfigDrawerOpen(true)}
                            isIconOnly={true}
                            variant="faded"
                            color="primary"
                            aria-label="Edit config file"
                            title="Edit config file"
                            data-focus-visible="false"
                            size="sm"
                        >
                            <FileTextIcon className="w-4 h-4" />
                        </Button>
                        <Button
                            onPress={() => {
                                // The list unmounts while it reloads: the cards ask again as
                                // they return, so nothing is refetched here.
                                forgetRemoteHealth({ refetch: false })
                                void remotesQuery.refetch()
                            }}
                            isIconOnly={true}
                            variant="faded"
                            color="primary"
                            data-focus-visible="false"
                            size="sm"
                            isDisabled={remotesQuery.isRefetching}
                        >
                            <RefreshCcwIcon className="w-4 h-4" />
                        </Button>
                        <Button
                            onPress={() => setCreatingDrawerOpen(true)}
                            isIconOnly={true}
                            variant="faded"
                            color="primary"
                            data-focus-visible="false"
                            size="sm"
                        >
                            <PlusIcon className="w-4 h-4" />
                        </Button>
                    </div>
                ),
            }}
        >
            {Placeholder}

            {!Placeholder && (
                <div className="flex flex-col gap-2.5 px-4">
                    {sortedRemotes.length > 5 && (
                        <Input
                            placeholder="Search remotes..."
                            value={searchQuery}
                            onValueChange={setSearchQuery}
                            startContent={<SearchIcon className="w-4 h-4 opacity-50" />}
                            size="sm"
                            variant="flat"
                            isClearable={true}
                            onClear={() => setSearchQuery('')}
                            data-focus-visible="false"
                            classNames={{ inputWrapper: 'bg-content2/60' }}
                        />
                    )}
                    <div
                        ref={scrollRef}
                        className="overflow-y-auto overscroll-none max-h-[calc(100dvh-14rem)] pb-10"
                    >
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
                                // Offset via `top`, not translateY: the entrance
                                // animation drives `transform` and would override it.
                                const style = {
                                    position: 'absolute',
                                    top: `${virtualRow.start}px`,
                                    left: 0,
                                    width: '100%',
                                    height: `${virtualRow.size}px`,
                                } as const

                                if (row.type === 'header') {
                                    return (
                                        <div key={`h-${row.key}`} style={style}>
                                            <div className="flex items-end h-full px-1 pb-1">
                                                <span className="text-xs font-semibold tracking-wide uppercase text-default-400">
                                                    {row.key}
                                                </span>
                                            </div>
                                        </div>
                                    )
                                }

                                const remote = row.remote
                                return (
                                    <div key={`r-${remote}`} className="pb-2.5" style={style}>
                                        <RemoteCard
                                            remote={remote}
                                            onAutoMountPress={() => {
                                                startTransition(() => {
                                                    setMountRemote(remote)
                                                    setOpening((n) => n + 1)
                                                    setAutoMountDrawerOpen(true)
                                                })
                                            }}
                                            onConfigPress={() => {
                                                startTransition(() => {
                                                    setEditRemote(remote)
                                                    setOpening((n) => n + 1)
                                                    setEditingDrawerOpen(true)
                                                })
                                            }}
                                            onDeletePress={async () => {
                                                const confirmation = await ask(
                                                    `Are you sure you want to remove ${remote}? This action cannot be reverted.`,
                                                    {
                                                        title: `Removing ${remote}`,
                                                        kind: 'warning',
                                                    }
                                                )

                                                if (!confirmation) {
                                                    return
                                                }

                                                deleteRemoteMutation.mutate(remote)
                                            }}
                                        />
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </div>
            )}

            <ConfigEditDrawer
                isOpen={configDrawerOpen}
                onClose={() => setConfigDrawerOpen(false)}
            />

            {editRemote && (
                <RemoteEditDrawer
                    key={`${editRemote}-${opening}`}
                    isOpen={editingDrawerOpen}
                    onClose={() => setEditingDrawerOpen(false)}
                    remoteName={editRemote}
                />
            )}

            <RemoteCreateDrawer
                isOpen={creatingDrawerOpen}
                onClose={() => {
                    startTransition(() => {
                        setCreatingDrawerOpen(false)
                    })
                }}
            />

            {mountRemote && (
                <RemoteAutoMountDrawer
                    key={`${mountRemote}-${opening}`}
                    isOpen={autoMountDrawerOpen}
                    onClose={() => {
                        startTransition(() => {
                            setAutoMountDrawerOpen(false)
                        })
                    }}
                    remoteName={mountRemote}
                />
            )}
        </BaseSection>
    )
}

function RemoteCard({
    remote,
    onAutoMountPress,
    onConfigPress,
    onDeletePress,
}: {
    remote: string
    onAutoMountPress: () => void
    onConfigPress: () => void
    onDeletePress: () => void
}) {
    const { data: remoteConfigData } = useQuery(remoteConfigQueryOptions(remote))

    const type = useMemo(() => remoteConfigData?.type ?? null, [remoteConfigData?.type])
    const provider = useMemo(() => remoteConfigData?.provider ?? null, [remoteConfigData?.provider])

    const health = useQuery(remoteHealthQueryOptions(remote)).data
    // Hidden only once the server has said it cannot mount, and asked again on every visit.
    const canMount = useQuery(mountSupportQueryOptions()).data?.supported !== false

    const { data: remoteAboutData } = useQuery({
        queryKey: ['remotes', remote, 'about'],
        queryFn: async () => {
            return await rclone('/operations/about', {
                params: {
                    query: {
                        fs: `${remote}:`,
                    },
                },
            })
        },
        enabled: health?.state === 'ok' && health.about,
    })

    const imageUrl = useMemo(
        () =>
            provider && !type ? `/icons/providers/${provider}.png` : `/icons/backends/${type}.png`,
        [provider, type]
    )

    const aboutData = useMemo(() => remoteAboutData, [remoteAboutData])

    return (
        <Card
            key={remote}
            data-remote={remote}
            shadow="sm"
            isBlurred={true}
            className="w-full h-20 border-[0.5px] dark:border-none border-divider bg-content3/50 dark:bg-content2/90"
            isPressable={true}
            onPress={onConfigPress}
        >
            <CardBody>
                <div className="flex items-center justify-between h-full">
                    <div className="flex items-center gap-4 shrink-0">
                        <img src={imageUrl} className="object-contain ml-2 size-10" alt={remote} />
                        <p className="text-large">{remote}</p>
                    </div>
                    <div className="flex items-center justify-end min-w-0 gap-4">
                        {/* rclone's reason, where the storage boxes would be. A `title`, not a
                            Tooltip: the whole card is a button. */}
                        {health?.state === 'faulty' && (
                            <p
                                title={health.error}
                                className="text-xs text-right text-danger line-clamp-2 [overflow-wrap:anywhere]"
                            >
                                {health.error}
                            </p>
                        )}
                        {/* Storage info boxes */}
                        {!!aboutData && (
                            <div className="flex items-center gap-2.5">
                                {aboutData.free !== undefined && (
                                    <StorageInfoBox
                                        label="Free"
                                        value={aboutData.free}
                                        color="success"
                                    />
                                )}
                                {aboutData.used !== undefined && (
                                    <StorageInfoBox
                                        label="Used"
                                        value={aboutData.used}
                                        color="warning"
                                    />
                                )}
                                {aboutData.total !== undefined && (
                                    <StorageInfoBox
                                        label="Total"
                                        value={aboutData.total}
                                        color="secondary"
                                    />
                                )}
                            </div>
                        )}

                        <Dropdown>
                            <DropdownTrigger>
                                <Button
                                    type="button"
                                    color="default"
                                    isIconOnly={true}
                                    radius="full"
                                    variant="light"
                                    aria-label={`Actions for ${remote}`}
                                >
                                    <SettingsIcon className="opacity-50 size-8 hover:opacity-100" />
                                </Button>
                            </DropdownTrigger>
                            <DropdownMenu
                                onAction={async (key) => {
                                    console.log(key)
                                    const keyAsString = key as string

                                    if (keyAsString === 'config') {
                                        onConfigPress()
                                    } else if (keyAsString === 'automount') {
                                        onAutoMountPress()
                                    } else if (keyAsString === 'delete') {
                                        onDeletePress()
                                    }
                                }}
                            >
                                <DropdownItem
                                    startContent={<PencilIcon className="w-4 h-4" />}
                                    key="config"
                                >
                                    Edit Config
                                </DropdownItem>
                                {canMount ? (
                                    <DropdownItem
                                        startContent={<CableIcon className="w-4 h-4" />}
                                        key="automount"
                                    >
                                        Auto Mount
                                    </DropdownItem>
                                ) : null}
                                <DropdownItem
                                    startContent={<Trash2Icon className="w-4 h-4" />}
                                    key="delete"
                                    color="danger"
                                >
                                    Delete
                                </DropdownItem>
                            </DropdownMenu>
                        </Dropdown>
                    </div>
                </div>
            </CardBody>
        </Card>
    )
}

const STORAGE_BOX_STYLES = {
    success: {
        bg: 'bg-success/10',
        text: 'text-success',
    },
    warning: {
        bg: 'bg-warning/10',
        text: 'text-warning',
    },
    secondary: {
        bg: 'bg-secondary/20',
        text: 'text-secondary-600',
    },
} as const

function StorageInfoBox({
    label,
    value,
    color,
}: {
    label: string
    value: number
    color: 'success' | 'warning' | 'secondary'
}) {
    const styles = STORAGE_BOX_STYLES[color]
    return (
        <div
            className={`flex flex-col w-16 items-center justify-center py-1 rounded-md ${styles.bg}`}
        >
            <span className={`text-[10px] uppercase font-medium ${styles.text}`}>{label}</span>
            <span className={`text-xs font-semibold ${styles.text}`}>{formatBytes(value)}</span>
        </div>
    )
}
