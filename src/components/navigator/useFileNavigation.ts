import { plural, t } from '@lingui/core/macro'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDebounce } from 'use-debounce'
import type { Browse } from '../../../lib/core/types'
import { compareText, foldCase, formatNumber } from '../../../lib/format'
import { locale } from '../../../lib/i18n'
import { onLive, onResync } from '../../../lib/live'
import { joinRemoteDir, pathProblem } from '../../../lib/paths'
import { useReconnectOffer } from '../../../lib/reconnect'
import { namesOf, useRemotes } from '../../../lib/remotes'
import { homeDir, isWindows } from '../../../lib/shell'
import { toastWarning } from '../toast'
import { useFavorites } from './favorites'
import { useFileDates } from './fileDates'
import { useFolderSizeJob } from './folderSizes'
import { useHiddenFiles } from './hiddenFiles'
import { useJob } from './jobs'
import {
    type Held,
    LIST_CAP,
    listingError,
    onFolderChanged,
    relisting,
    SEARCH_CAP,
    toEntries,
} from './listing'
import { listingKey } from './listingKey'
import {
    addTo,
    alreadySelected,
    folderHolding,
    removeFrom,
    type Selection,
    selectAllOf,
} from './selection'
import type {
    AllowedKey,
    Entry,
    PaddingItem,
    RemoteString,
    SelectItem,
    Sort,
    VirtualizedEntry,
} from './types'
import {
    BY_NAME,
    expandHome,
    favoriteRows,
    getLocalParent,
    getRemoteParent,
    joinLocal,
    log,
    panelFolder,
    parseRemotePath,
    placeOf,
    serializeRemotePath,
    unknownRemote,
    VIRTUAL_PADDING_COUNT,
} from './utils'

const exactCollator = new Intl.Collator(locale())

export interface PanelStatus {
    kind: 'active' | 'warning'
    text: string
}

const EMPTY: Entry[] = []
const NOTHING_HELD: Held<Entry> = { at: null, rows: EMPTY, complete: false }

export default function useFileNavigation({
    initialRemote,
    initialPath,
    startAtFirstRemote = false,
    initialSort = BY_NAME,
    initialSelection,
    allowedKeys = ['REMOTES', 'LOCAL_FS', 'LOCAL_FS_EXTRA', 'FAVORITES'],
    allowFiles = true,
    allowMultiple = true,
    isActive = true,
}: {
    initialRemote?: string | 'UI_LOCAL_FS'
    initialPath?: string
    startAtFirstRemote?: boolean
    initialSort?: Sort
    initialSelection?: SelectItem[]
    allowedKeys?: AllowedKey[]
    allowFiles?: boolean
    allowMultiple?: boolean
    isActive?: boolean
}) {
    const favoritePaths = useFavorites()
    const home = homeDir()
    const { remotes: configured, query: remotesQuery } = useRemotes()
    const remoteNames = namesOf(configured).join('\n')
    const remotes = useMemo(() => (remoteNames ? remoteNames.split('\n') : []), [remoteNames])
    const remotesKnown = remotesQuery.isSuccess
    const remotesSettled = remotesQuery.isSuccess || remotesQuery.isError

    const [selectedRemote, setSelectedRemote] = useState<RemoteString>(initialRemote ?? null)
    const [cwd, setCwd] = useState<string>(initialPath ?? '')
    const [pathInput, setPathInput] = useState<string>('')
    const [searchTerm, setSearchTerm] = useState<string>('')
    const [searchInSubfolders, setSearchInSubfolders] = useState(false)
    const [sortDescriptor, setSortDescriptor] = useState<Sort>(initialSort)
    const [pathError, setPathError] = useState<string | null>(null)
    const [isUpDisabled, setIsUpDisabled] = useState(false)
    const [showLoading, setShowLoading] = useState(false)

    const isRemote = useMemo(
        () =>
            selectedRemote !== 'UI_LOCAL_FS' &&
            selectedRemote !== 'UI_FAVORITES' &&
            selectedRemote !== null,
        [selectedRemote]
    )
    const canShowFavorites = useMemo(() => allowedKeys.includes('FAVORITES'), [allowedKeys])
    const canShowLocal = useMemo(() => allowedKeys.includes('LOCAL_FS'), [allowedKeys])
    const canShowRemotes = useMemo(() => allowedKeys.includes('REMOTES'), [allowedKeys])

    const isNavigatingRef = useRef(false)

    const [selected, setSelected] = useState<Selection>(
        () => new Map((initialSelection ?? []).map((item) => [item.path, item.type]))
    )
    const selectedPaths = useMemo(() => new Set(selected.keys()), [selected])

    const isFavorites = selectedRemote === 'UI_FAVORITES'
    const listingEnabled =
        isActive && !!selectedRemote && !isFavorites && !(selectedRemote === 'UI_LOCAL_FS' && !cwd)
    const location = useMemo(
        () => (listingEnabled ? panelFolder(selectedRemote, cwd) : null),
        [listingEnabled, selectedRemote, cwd]
    )
    const [fileDates] = useFileDates()
    const [hidden] = useHiddenFiles()
    const listing = useJob<Browse.Row>('list', location ? { path: location, fileDates } : null, {
        cap: LIST_CAP,
    })
    const current = location !== null && listing.args?.path === location

    const sizes = useFolderSizeJob(
        listing,
        current && selectedRemote === 'UI_LOCAL_FS' ? location : null
    )

    const listed = useMemo(
        () =>
            current ? toEntries(listing.items, selectedRemote as string, { sizes, hidden }) : EMPTY,
        [current, listing.items, selectedRemote, sizes, hidden]
    )
    const [held, setHeld] = useState<Held<Entry>>(NOTHING_HELD)
    const waiting =
        location !== null &&
        (!current || (listing.phase === 'running' && listing.items.length === 0))
    const refreshing = relisting({ at: location, held, current, phase: listing.phase })
    useEffect(() => {
        if (listing.phase === 'failed') setHeld(NOTHING_HELD)
        else if (!waiting && !refreshing) {
            setHeld({ at: location, rows: listed, complete: listing.phase !== 'running' })
        }
    }, [listing.phase, waiting, refreshing, listed, location])

    const favoriteItems = useMemo(() => favoriteRows(favoritePaths), [favoritePaths])
    const items: Entry[] = isFavorites
        ? favoriteItems
        : !listingEnabled || (current && listing.phase === 'failed')
          ? EMPTY
          : waiting || refreshing
            ? held.rows
            : listed
    const error =
        pathError ??
        (current && listing.phase === 'failed'
            ? listingError(listing.error, listing.notFound)
            : null)
    const isLoading = showLoading && waiting && !refreshing

    const refreshListing = listing.refresh
    useReconnectOffer(listing.reconnect, refreshListing)

    const reaskListing = listing.reask
    const panelKey = useMemo(
        () => (selectedRemote && !isFavorites ? listingKey(selectedRemote, cwd) : null),
        [selectedRemote, isFavorites, cwd]
    )
    useEffect(() => {
        if (!panelKey) return
        const offChanged = onFolderChanged((changed) => {
            if (changed(panelKey)) reaskListing()
        })
        const offRemotes = isRemote ? onLive('remotes.changed', () => reaskListing()) : null
        const offResync = onResync(() => reaskListing())
        return () => {
            offChanged()
            offRemotes?.()
            offResync()
        }
    }, [panelKey, reaskListing, isRemote])

    const recursiveSearchActive = searchInSubfolders && searchTerm.trim().length > 0

    const [typedTerm] = useDebounce(searchTerm.trim(), 350)
    const searchLocation = useMemo(() => panelFolder(selectedRemote, cwd), [selectedRemote, cwd])
    const searchJob = useJob<Browse.Row>(
        'search',
        isActive && recursiveSearchActive && typedTerm && searchLocation
            ? { path: searchLocation, q: typedTerm, fileDates, hidden }
            : null,
        { cap: SEARCH_CAP }
    )
    const recursiveSearchItems = useMemo(
        () =>
            searchLocation && searchJob.phase !== 'idle' && searchJob.args?.path === searchLocation
                ? toEntries(searchJob.items, selectedRemote as string, { search: true, hidden })
                : null,
        [searchLocation, searchJob.phase, searchJob.args, searchJob.items, selectedRemote, hidden]
    )
    const searchPending = recursiveSearchActive && typedTerm !== searchTerm.trim()
    const isSearching =
        recursiveSearchActive &&
        (searchPending || searchJob.phase === 'running') &&
        searchJob.items.length === 0
    const searchError =
        recursiveSearchActive && searchJob.phase === 'failed'
            ? t`Unable to search this folder`
            : null
    const refreshSearchJob = searchJob.refresh
    useReconnectOffer(searchJob.reconnect, refreshSearchJob)

    let status: PanelStatus | null = null
    if (recursiveSearchActive) {
        const found = searchJob.items.length
        if (searchJob.capped) {
            const count = formatNumber(found)
            status = { kind: 'warning', text: t`Showing the first ${count} matches` }
        } else if (searchJob.phase === 'running' && found > 0) {
            status = {
                kind: 'active',
                text: plural(found, { one: 'Searching… # match', other: 'Searching… # matches' }),
            }
        }
    } else if (!isFavorites && listingEnabled) {
        const listedCount = listing.items.length
        if (listing.capped) {
            const count = formatNumber(listedCount)
            status = { kind: 'warning', text: t`Showing the first ${count} entries` }
        } else if (listing.phase === 'running' && listedCount > 0) {
            status = {
                kind: 'active',
                text: plural(listedCount, {
                    one: 'Listing… # entry',
                    other: 'Listing… # entries',
                }),
            }
        }
    }

    const visibleItems = useMemo(() => {
        const base = recursiveSearchActive ? (recursiveSearchItems ?? []) : items
        const normalizedSearchTerm = recursiveSearchActive ? searchTerm.trim() : searchTerm
        const lower = foldCase(normalizedSearchTerm)
        const filtered = normalizedSearchTerm
            ? base.filter((item) => foldCase(item.name).includes(lower))
            : base
        const direction = sortDescriptor.direction === 'ascending' ? 1 : -1

        return [...filtered].sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1

            const aName = a.displayName ?? a.name
            const bName = b.displayName ?? b.name
            const nameComparison =
                compareText(aName, bName) ||
                exactCollator.compare(aName, bName) ||
                exactCollator.compare(a.key, b.key)

            if (sortDescriptor.column === 'name') return nameComparison * direction

            const aValue =
                sortDescriptor.column === 'size'
                    ? typeof a.size === 'number' && a.size >= 0
                        ? a.size
                        : undefined
                    : a.modTime
                      ? Date.parse(a.modTime)
                      : undefined
            const bValue =
                sortDescriptor.column === 'size'
                    ? typeof b.size === 'number' && b.size >= 0
                        ? b.size
                        : undefined
                    : b.modTime
                      ? Date.parse(b.modTime)
                      : undefined
            const normalizedA = aValue !== undefined && Number.isFinite(aValue) ? aValue : undefined
            const normalizedB = bValue !== undefined && Number.isFinite(bValue) ? bValue : undefined

            if (normalizedA === undefined && normalizedB !== undefined) return 1
            if (normalizedA !== undefined && normalizedB === undefined) return -1
            if (
                normalizedA !== undefined &&
                normalizedB !== undefined &&
                normalizedA !== normalizedB
            ) {
                return (normalizedA - normalizedB) * direction
            }
            return nameComparison
        })
    }, [items, recursiveSearchActive, recursiveSearchItems, searchTerm, sortDescriptor])

    const handleSort = useCallback((column: Sort['column']) => {
        setSortDescriptor((current) => ({
            column,
            direction:
                current.column === column && current.direction === 'ascending'
                    ? 'descending'
                    : 'ascending',
        }))
    }, [])

    const favoritedKeys = useMemo(() => {
        const map: Record<string, boolean> = {}
        for (const it of favoritePaths) if (it.path) map[it.path] = true
        return map
    }, [favoritePaths])

    const virtualizedItems: (VirtualizedEntry | PaddingItem)[] = useMemo(() => {
        const base: (VirtualizedEntry | PaddingItem)[] = visibleItems.map((item) => ({
            ...item,
            isSelected: selected.has(item.key),
            isFavorited: favoritedKeys[item.key] ?? false,
        }))
        for (let i = 0; i < VIRTUAL_PADDING_COUNT; i++) {
            base.push({ key: `__padding-${i}`, padding: true })
        }
        return base
    }, [visibleItems, selected, favoritedKeys])

    const selectedCount = selected.size

    const cleanupSelectionForRemote = useCallback(
        (newRemote: RemoteString) => {
            log('cleanupSelectionForRemote', { newRemote, selectedRemote })
            if (newRemote !== selectedRemote) {
                startTransition(() => {
                    setSelected(new Map())
                })
            }
        },
        [selectedRemote]
    )

    const updatePathInput = useCallback((nextRemote: RemoteString, nextCwd: string) => {
        if (!nextRemote) {
            startTransition(() => setPathInput(''))
            return
        }
        if (nextRemote === 'UI_FAVORITES') {
            startTransition(() => setPathInput(''))
            return
        }
        if (nextRemote === 'UI_LOCAL_FS') {
            startTransition(() => setPathInput(nextCwd || ''))
        } else {
            startTransition(() => setPathInput(serializeRemotePath(nextRemote, nextCwd || '')))
        }
    }, [])

    const handleNavigate = useCallback(
        async (entry: Entry) => {
            log('handleNavigate', { entry, isNavigating: isNavigatingRef.current, selectedRemote })
            if (isNavigatingRef.current) return
            if (!entry.isDir) return
            if (!selectedRemote) return
            if (selectedRemote === 'UI_FAVORITES') {
                const place = placeOf(entry.fullPath)
                cleanupSelectionForRemote(place.remote)
                startTransition(() => {
                    setSelectedRemote(place.remote)
                    setCwd(place.cwd)
                })
                return
            }
            isNavigatingRef.current = true
            if (recursiveSearchActive) {
                const resultPath = isRemote ? parseRemotePath(entry.fullPath).path : entry.fullPath
                startTransition(() => setCwd(resultPath))
                return
            }
            if (isRemote) {
                startTransition(() => setCwd(joinRemoteDir(cwd, entry.name)))
            } else {
                const newPath = await joinLocal(cwd, entry.name)
                startTransition(() => setCwd(newPath))
            }
        },
        [selectedRemote, recursiveSearchActive, isRemote, cwd, cleanupSelectionForRemote]
    )

    const navigateUp = useCallback(async () => {
        log('navigateUp', { cwd, selectedRemote })
        if (!selectedRemote) return
        if (isRemote) {
            const parent = getRemoteParent(cwd)
            startTransition(() => setCwd(parent))
        }
        if (selectedRemote === 'UI_LOCAL_FS') {
            const parent = await getLocalParent(cwd)
            startTransition(() => setCwd(parent))
            return
        }
    }, [cwd, selectedRemote, isRemote])

    const refresh = useCallback(() => {
        setPathError(null)
        refreshListing()
        refreshSearchJob()
    }, [refreshListing, refreshSearchJob])

    const navigateTo = useCallback(
        (path: string) => {
            const value = expandHome(path, home, isWindows())
            if (!value) return
            const problem =
                pathProblem(value) ?? unknownRemote(value, remotesKnown ? remotes : undefined)
            if (problem) {
                setPathError(problem)
                return
            }
            const { remote: nextRemote, cwd: nextCwd } = placeOf(value)
            if (nextRemote === selectedRemote && nextCwd === cwd) {
                refresh()
                return
            }
            cleanupSelectionForRemote(nextRemote)
            startTransition(() => {
                setSelectedRemote(nextRemote)
                setCwd(nextCwd)
            })
        },
        [cleanupSelectionForRemote, selectedRemote, cwd, refresh, home, remotes, remotesKnown]
    )

    const selectRemote = useCallback(
        async (remote: string | 'UI_LOCAL_FS' | 'UI_FAVORITES', initialPath?: string) => {
            cleanupSelectionForRemote(remote)
            if (remote === 'UI_LOCAL_FS') {
                const startPath = initialPath ?? home
                startTransition(() => {
                    setSelectedRemote(remote)
                    setCwd(startPath)
                })
            } else {
                startTransition(() => {
                    setSelectedRemote(remote)
                    setCwd(initialPath ?? '')
                })
            }
        },
        [cleanupSelectionForRemote, home]
    )

    const handleToggleSelect = useCallback(
        (entry: Entry) => {
            if (!allowFiles && !entry.isDir) return
            const holder = selected.has(entry.key) ? undefined : folderHolding(selected, entry.key)
            if (holder) {
                const { title, description } = alreadySelected(holder)
                toastWarning(title, description)
                return
            }
            startTransition(() =>
                setSelected((prev) => {
                    const next = new Map(prev)
                    if (next.has(entry.key)) {
                        removeFrom(next, entry.key)
                        return next
                    }
                    if (!allowMultiple && next.size > 0) return prev
                    addTo(next, entry)
                    return next
                })
            )
        },
        [allowFiles, allowMultiple, selected]
    )

    const getSelection = useCallback(
        (): SelectItem[] => Array.from(selected, ([path, type]) => ({ path, type })),
        [selected]
    )

    const clearSelection = useCallback(() => {
        startTransition(() => setSelected(new Map()))
    }, [])

    const deselect = useCallback((keys: string[]) => {
        startTransition(() =>
            setSelected((prev) => {
                const next = new Map(prev)
                for (const key of keys) removeFrom(next, key)
                return next.size === prev.size ? prev : next
            })
        )
    }, [])

    const selectAll = useCallback(
        (type: 'files' | 'folders' | 'all') => {
            const wanted = visibleItems.filter(
                (item) =>
                    (allowFiles || item.isDir) &&
                    (type === 'all' || (type === 'files' ? !item.isDir : item.isDir))
            )
            const { next, holder } = selectAllOf(selected, wanted)
            if (holder) {
                const { title, description } = alreadySelected(holder)
                toastWarning(title, description)
            }
            startTransition(() => setSelected(next))
        },
        [allowFiles, visibleItems, selected]
    )

    const hasInitializedRef = useRef(false)
    useEffect(() => {
        if (!isActive) {
            hasInitializedRef.current = false
            return
        }
        if (hasInitializedRef.current) return

        const hasInitial = initialRemote !== undefined
        const needsLocalPath = initialRemote === 'UI_LOCAL_FS' && initialPath === undefined

        if (!hasInitial && startAtFirstRemote && canShowRemotes) {
            if (!remotesSettled) return
            hasInitializedRef.current = true
            const first = remotes[0]
            startTransition(() => {
                setSelectedRemote(first ?? 'UI_LOCAL_FS')
                setCwd(first ? '' : home)
            })
        } else if (needsLocalPath || (!hasInitial && canShowLocal)) {
            hasInitializedRef.current = true
            startTransition(() => {
                setSelectedRemote('UI_LOCAL_FS')
                setCwd(home)
                setPathInput(home)
            })
        } else if (!hasInitial && canShowFavorites) {
            hasInitializedRef.current = true
            startTransition(() => setSelectedRemote('UI_FAVORITES'))
        } else if (!hasInitial && canShowRemotes) {
            if (remotes.length > 0) {
                hasInitializedRef.current = true
                startTransition(() => {
                    setSelectedRemote(remotes[0])
                    setCwd('')
                })
            }
        } else {
            hasInitializedRef.current = true
        }
    }, [
        isActive,
        canShowLocal,
        canShowFavorites,
        canShowRemotes,
        remotes,
        remotesSettled,
        startAtFirstRemote,
        initialRemote,
        initialPath,
        home,
    ])

    useEffect(() => {
        if (!waiting) {
            setShowLoading(false)
            return
        }
        const timer = setTimeout(() => setShowLoading(true), 200)
        return () => clearTimeout(timer)
    }, [waiting])

    // biome-ignore lint/correctness/useExhaustiveDependencies: a folder served at once is never waited for, so the folder itself must re-run this
    useEffect(() => {
        if (!waiting) isNavigatingRef.current = false
    }, [waiting, selectedRemote, cwd])

    useEffect(() => {
        updatePathInput(selectedRemote, cwd)
        setSearchTerm('')
        setPathError(null)
    }, [selectedRemote, cwd, updatePathInput])

    // biome-ignore lint/correctness/useExhaustiveDependencies: the folder changing is what clears it
    useEffect(() => {
        if (!allowMultiple) setSelected((prev) => (prev.size === 0 ? prev : new Map()))
    }, [allowMultiple, selectedRemote, cwd])

    useEffect(() => {
        let cancelled = false
        async function updateUpState() {
            if (!selectedRemote) {
                if (!cancelled) setIsUpDisabled(true)
                return
            }
            if (isRemote) {
                if (!cancelled) setIsUpDisabled(cwd === '' || cwd === '/')
                return
            }
            const current = cwd
            if (!current) {
                if (!cancelled) setIsUpDisabled(true)
                return
            }
            let parent = ''
            try {
                parent = await getLocalParent(current)
            } catch {
                parent = current
            }
            if (cancelled) return
            setIsUpDisabled(parent === current)
        }
        updateUpState()
        return () => {
            cancelled = true
        }
    }, [selectedRemote, cwd, isRemote])

    return {
        selectedRemote,
        cwd,
        pathInput,
        items,
        visibleItems,
        virtualizedItems,
        isLoading,
        isRefreshing: refreshing,
        isSearching,
        error,
        searchError,
        status,
        isUpDisabled,
        searchTerm,
        searchInSubfolders,
        recursiveSearchActive,
        sortDescriptor,
        selectedPaths,
        selectedCount,
        isRemote,
        favoritedKeys,
        remotes,
        canShowFavorites,
        canShowLocal,
        canShowRemotes,

        setPathInput,
        setSearchTerm,
        setSearchInSubfolders,
        handleSort,
        handleNavigate,
        navigateUp,
        navigateTo,
        selectRemote,
        handleToggleSelect,
        getSelection,
        clearSelection,
        deselect,
        selectAll,
        refresh,

        setSelectedRemote,
        setCwd,
    }
}
