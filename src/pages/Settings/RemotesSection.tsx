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
import { ask, message } from '@tauri-apps/plugin-dialog'
import { platform } from '@tauri-apps/plugin-os'
import {
    CableIcon,
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
import { hasFeature, remoteConfigQueryOptions, useFsInfo } from '../../../lib/hooks'
import rclone from '../../../lib/rclone/client'
import { usePersistedStore } from '../../../store/persisted'
import RemoteAutoMountDrawer from '../../components/RemoteAutoMountDrawer'
import RemoteCreateDrawer from '../../components/RemoteCreateDrawer'
import RemoteEditDrawer from '../../components/RemoteEditDrawer'
import BaseSection from './BaseSection'

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
    const licenseValid = usePersistedStore((state) => state.licenseValid)

    const [editingDrawerOpen, setEditingDrawerOpen] = useState(false)
    const [creatingDrawerOpen, setCreatingDrawerOpen] = useState(false)
    const [autoMountDrawerOpen, setAutoMountDrawerOpen] = useState(false)

    const remotesQuery = useQuery({
        queryKey: ['remotes', 'list', 'all'],
        queryFn: async () => {
            const [remotes] = await Promise.all([
                rclone('/config/listremotes').then((r) => r?.remotes),
                new Promise((resolve) => setTimeout(resolve, 1400)),
            ])
            return remotes
        },
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

    const [pickedRemote, setPickedRemote] = useState<string | null>(null)

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
            queryClient.setQueryData(['remotes', 'list', 'all'], (old: string[] | undefined) => [
                ...(old ?? []).filter((r) => r !== remote),
            ])
        },
        onError: onErrorDialog('Could not delete remote', 'Unknown error occurred', {
            capture: false,
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

    useEffect(() => {
        const tab = searchParams.get('tab')
        const action = searchParams.get('action')
        const remote = searchParams.get('remote')

        if (tab === 'remotes' && action === 'create') {
            startTransition(() => {
                setCreatingDrawerOpen(true)
            })
        } else if (tab === 'remotes' && action === 'edit' && remote) {
            startTransition(() => {
                setPickedRemote(remote)
                setEditingDrawerOpen(true)
            })
        } else if (tab === 'remotes' && action === 'auto-mount' && remote) {
            startTransition(() => {
                setPickedRemote(remote)
                setAutoMountDrawerOpen(true)
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
                            onPress={() => {
                                setTimeout(async () => {
                                    await remotesQuery.refetch()
                                }, 100)
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
                            onPress={() => {
                                setTimeout(async () => {
                                    if (!licenseValid && remotes.length >= 4) {
                                        await message(
                                            'Community version does not support adding more than 4 remotes.',
                                            {
                                                title: 'Missing license',
                                                kind: 'error',
                                            }
                                        )
                                        return
                                    }

                                    setCreatingDrawerOpen(true)
                                }, 100)
                            }}
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
                                                    setPickedRemote(remote)
                                                    setAutoMountDrawerOpen(true)
                                                })
                                            }}
                                            onConfigPress={() => {
                                                startTransition(() => {
                                                    setPickedRemote(remote)
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

            {pickedRemote && (
                <RemoteEditDrawer
                    isOpen={editingDrawerOpen}
                    onClose={() => {
                        setEditingDrawerOpen(false)
                        setTimeout(() => {
                            // allow for drawer effect to happen
                            setPickedRemote(null)
                        }, 100)
                    }}
                    remoteName={pickedRemote}
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

            {pickedRemote && (
                <RemoteAutoMountDrawer
                    isOpen={autoMountDrawerOpen}
                    onClose={() => {
                        startTransition(() => {
                            setAutoMountDrawerOpen(false)
                            setTimeout(() => {
                                // allow for drawer effect to happen
                                setPickedRemote(null)
                            }, 100)
                        })
                    }}
                    remoteName={pickedRemote}
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

    const fsInfoQuery = useFsInfo(remote)
    const supportsAbout = hasFeature(fsInfoQuery.data, 'About')

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
        enabled: supportsAbout,
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
                    <div className="flex items-center gap-4">
                        <img src={imageUrl} className="object-contain ml-2 size-10" alt={remote} />
                        <p className="text-large">{remote}</p>
                    </div>
                    <div className="flex items-center justify-end gap-4">
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

                        <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
                            <DropdownTrigger>
                                <Button
                                    type="button"
                                    color="default"
                                    isIconOnly={true}
                                    radius="full"
                                    variant="light"
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
                                <DropdownItem
                                    startContent={<CableIcon className="w-4 h-4" />}
                                    key="automount"
                                >
                                    Auto Mount
                                </DropdownItem>
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
