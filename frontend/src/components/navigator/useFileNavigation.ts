import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import rclone from '@/lib/rclone/client'
import { usePersistedStore } from '@/store'
import type {
    AllowedKey,
    Entry,
    PaddingItem,
    RemoteString,
    SelectItem,
    VirtualizedEntry,
} from './types'
import {
    RE_BACKSLASH,
    RE_LEADING_SLASH,
    RE_PATH_SEPARATOR,
    RE_TRAILING_SLASH,
    VIRTUAL_PADDING_COUNT,
    getLocalParent,
    getRemoteParent,
    joinLocal,
    log,
    parseRemotePath,
    searchPath,
    serializeRemotePath,
} from './utils'
import { joinRemoteDir, parsePath, pathProblem } from '@/lib/paths'
import { folderSize } from '@/lib/rclone/daemon-fs'
import { home } from '@/server/boot'
import { LISTING_FAILED, invalidateListing, listingQueryOptions, patchListing } from './listing'
import { listingKey } from './listingKey'

const nameCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
})

const EMPTY: Entry[] = []

// Favourites are held in the persisted document, so the rows are built, never fetched.
function favoriteRows(favoritePaths: readonly unknown[] | undefined): Entry[] {
    return (favoritePaths || []).map((fav) => {
        const remote = (fav as any).remote as string | undefined
        const isLocal = !remote || remote === 'UI_LOCAL_FS'
        const rawPath = (fav as any).path as string
        // Kept under its remote as the user had it (a leading slash is the absolute root).
        const fullPath = isLocal ? rawPath : serializeRemotePath(remote!, rawPath || '')
        const normalized = (rawPath || '').replace(RE_BACKSLASH, '/').replace(RE_TRAILING_SLASH, '')
        const baseName = normalized.split(RE_PATH_SEPARATOR).pop() || ''
        const prefix = isLocal ? '(LOCAL)' : `(${remote})`
        const addedLabel = `Added on ${new Date((fav as any).added).toLocaleString()}`
        return {
            key: fullPath,
            name: `${prefix} ${baseName}`,
            isDir: true,
            size: undefined,
            modTime: addedLabel,
            remote: isLocal ? 'UI_LOCAL_FS' : remote,
            fullPath,
        } as Entry
    })
}

export default function useFileNavigation({
    initialRemote,
    initialPath,
    allowedKeys = ['REMOTES', 'LOCAL_FS', 'LOCAL_FS_EXTRA', 'FAVORITES'],
    allowFiles = true,
    allowMultiple = true,
    isActive = true,
}: {
    initialRemote?: string | 'UI_LOCAL_FS'
    initialPath?: string
    allowedKeys?: AllowedKey[]
    allowFiles?: boolean
    allowMultiple?: boolean
    isActive?: boolean
}) {
    const favoritePaths = usePersistedStore((state) => state.favoritePaths)
    const queryClient = useQueryClient()

    const remotesQuery = useQuery({
        queryKey: ['remotes', 'list', 'all'],
        queryFn: async () => await rclone('/config/listremotes').then((r) => r?.remotes),
        staleTime: 1000 * 60,
    })

    const remotes = useMemo(() => remotesQuery.data ?? [], [remotesQuery.data])

    const [selectedRemote, setSelectedRemote] = useState<RemoteString>(initialRemote ?? null)
    const [cwd, setCwd] = useState<string>(initialPath ?? '')
    const [pathInput, setPathInput] = useState<string>('')
    const [searchTerm, setSearchTerm] = useState<string>('')
    const [searchInSubfolders, setSearchInSubfolders] = useState(false)
    const [recursiveSearchItems, setRecursiveSearchItems] = useState<Entry[] | null>(null)
    const [isSearching, setIsSearching] = useState(false)
    const [searchError, setSearchError] = useState<string | null>(null)
    const [sortDescriptor, setSortDescriptor] = useState<{
        column: 'name' | 'size' | 'modTime'
        direction: 'ascending' | 'descending'
    }>({ column: 'name', direction: 'ascending' })
    // What the path bar refused (`pathProblem`); a listing's own failure is the query's.
    const [pathError, setPathError] = useState<string | null>(null)
    const [isUpDisabled, setIsUpDisabled] = useState(false)
    // Refresh re-runs a recursive search too; the listing itself is refetched by invalidation.
    const [searchTick, setSearchTick] = useState(0)
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
    const searchRequestSequenceRef = useRef(0)

    // The selection is one ordered map: the path, and what it is. It used to be a set of paths
    // beside a ref holding their types, which every operation that touched one had to touch in
    // step with the other.
    const [selected, setSelected] = useState<Map<string, 'file' | 'folder'>>(new Map())
    // The panel's table takes a set of keys, so the set is derived rather than kept.
    const selectedPaths = useMemo(() => new Set(selected.keys()), [selected])

    // The directory's rows are one app-wide query (`listing.ts`): fresh for a while, shared by
    // every panel and drawer, alive across the page. Favourites are built from the document,
    // and the local sidebar's roots have no folder to list.
    const isFavorites = selectedRemote === 'UI_FAVORITES'
    const listingEnabled =
        isActive && !!selectedRemote && !isFavorites && !(selectedRemote === 'UI_LOCAL_FS' && !cwd)
    const listing = useQuery({
        ...listingQueryOptions(
            listingEnabled ? (selectedRemote as string) : 'UI_LOCAL_FS',
            listingEnabled ? cwd : ''
        ),
        enabled: listingEnabled,
        // The folder just left stays on screen until the next one's rows are in.
        placeholderData: keepPreviousData,
    })
    const favoriteItems = useMemo(() => favoriteRows(favoritePaths), [favoritePaths])
    // A failed listing shows nothing from before it; a disabled one shows nothing at all.
    const items: Entry[] = isFavorites
        ? favoriteItems
        : !listingEnabled || listing.isError
          ? EMPTY
          : (listing.data ?? EMPTY)
    const error = pathError ?? (listing.isError ? LISTING_FAILED : null)
    const isLoading = showLoading

    const recursiveSearchActive = searchInSubfolders && searchTerm.trim().length > 0

    const visibleItems = useMemo(() => {
        const sourceItems = recursiveSearchActive ? (recursiveSearchItems ?? []) : items
        const base = allowFiles ? sourceItems : sourceItems.filter((it) => it.isDir)
        const normalizedSearchTerm = recursiveSearchActive ? searchTerm.trim() : searchTerm
        const lower = normalizedSearchTerm.toLowerCase()
        const filtered = normalizedSearchTerm
            ? base.filter((item) => item.name.toLowerCase().includes(lower))
            : base
        const direction = sortDescriptor.direction === 'ascending' ? 1 : -1

        return [...filtered].sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1

            const aName = a.displayName ?? a.name
            const bName = b.displayName ?? b.name
            const nameComparison =
                nameCollator.compare(aName, bName) ||
                aName.localeCompare(bName) ||
                a.key.localeCompare(b.key)

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
    }, [allowFiles, items, recursiveSearchActive, recursiveSearchItems, searchTerm, sortDescriptor])

    const handleSort = useCallback((column: 'name' | 'size' | 'modTime') => {
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
        for (const it of favoritePaths || []) {
            const remote = (it as any).remote as string | undefined
            const rawPath = (it as any).path as string
            // The path under its remote, as it was kept: a leading slash is the absolute root.
            const fullKey =
                remote && remote !== 'UI_LOCAL_FS'
                    ? serializeRemotePath(remote, rawPath || '')
                    : rawPath
            if (fullKey) map[fullKey] = true
        }
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
                const full = entry.fullPath
                const parsed = parsePath(full)
                if (parsed.kind === 'remote') {
                    cleanupSelectionForRemote(parsed.name)
                    startTransition(() => {
                        setSelectedRemote(parsed.name)
                        setCwd(parsed.path.replace(RE_TRAILING_SLASH, ''))
                    })
                } else {
                    cleanupSelectionForRemote('UI_LOCAL_FS')
                    startTransition(() => {
                        setSelectedRemote('UI_LOCAL_FS')
                        setCwd(full)
                    })
                }
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

    // The panel's own ask: this folder, again, whatever its age.
    const refresh = useCallback(() => {
        setPathError(null)
        setSearchTick((k) => k + 1)
        if (selectedRemote && selectedRemote !== 'UI_FAVORITES') {
            void invalidateListing(selectedRemote, cwd)
        }
    }, [selectedRemote, cwd])

    const navigateTo = useCallback(
        (path: string) => {
            const value = path.trim()
            if (!value) return
            // rclone's own reading of the string (`lib/paths.ts`): `remote:folder` is the remote,
            // `C:\Users` is a drive on a Windows host. What rclone would refuse, or would read as
            // something else than meant, is said here and goes nowhere.
            const problem = pathProblem(value)
            if (problem) {
                setPathError(problem)
                return
            }
            const parsed = parsePath(value)
            const [nextRemote, nextCwd] =
                parsed.kind === 'remote'
                    ? [parsed.name, parsed.path.replace(RE_TRAILING_SLASH, '')]
                    : (['UI_LOCAL_FS' as const, value] as const)
            // The place the panel is at already, entered again (after a path it refused, say):
            // nothing would change, so nothing would reload. A refresh is what was meant.
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
        [cleanupSelectionForRemote, selectedRemote, cwd, refresh]
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
        [cleanupSelectionForRemote]
    )

    const handleToggleSelect = useCallback(
        (entry: Entry) => {
            startTransition(() =>
                setSelected((prev) => {
                    const next = new Map(prev)
                    if (next.has(entry.key)) {
                        next.delete(entry.key)
                        return next
                    }
                    // A single-selection picker takes the first tick only.
                    if (!allowMultiple && next.size > 0) return prev
                    next.set(entry.key, entry.isDir ? 'folder' : 'file')
                    return next
                })
            )
        },
        [allowMultiple]
    )

    // Every way into the selection records what the row is, so there is nothing left to guess
    // from the entry cache or the shape of the path.
    const getSelection = useCallback(
        (): SelectItem[] => Array.from(selected, ([path, type]) => ({ path, type })),
        [selected]
    )

    const clearSelection = useCallback(() => {
        startTransition(() => setSelected(new Map()))
    }, [])

    /** Drops entries from the selection (a picker's row that was renamed or deleted). */
    const deselect = useCallback((keys: string[]) => {
        startTransition(() =>
            setSelected((prev) => {
                if (!keys.some((key) => prev.has(key))) return prev
                const next = new Map(prev)
                for (const key of keys) next.delete(key)
                return next
            })
        )
    }, [])

    const selectAll = useCallback(
        (type: 'files' | 'folders' | 'all') => {
            startTransition(() =>
                setSelected((prev) => {
                    const next = new Map(prev)
                    for (const item of visibleItems) {
                        const wanted =
                            type === 'all' || (type === 'files' ? !item.isDir : item.isDir)
                        if (wanted) next.set(item.key, item.isDir ? 'folder' : 'file')
                    }
                    return next
                })
            )
        },
        [visibleItems]
    )

    useEffect(() => {
        const requestSequence = ++searchRequestSequenceRef.current
        const term = searchTerm.trim()

        if (
            !isActive ||
            !searchInSubfolders ||
            !term ||
            !selectedRemote ||
            selectedRemote === 'UI_FAVORITES'
        ) {
            startTransition(() => {
                setRecursiveSearchItems(null)
                setSearchError(null)
                setIsSearching(false)
            })
            return
        }

        const controller = new AbortController()
        startTransition(() => {
            setRecursiveSearchItems(null)
            setSearchError(null)
            setIsSearching(true)
        })

        const timeoutId = setTimeout(async () => {
            try {
                const result = await searchPath(
                    selectedRemote as string | 'UI_LOCAL_FS',
                    cwd,
                    term,
                    controller.signal
                )
                if (
                    controller.signal.aborted ||
                    searchRequestSequenceRef.current !== requestSequence
                ) {
                    return
                }

                const lowerTerm = term.toLowerCase()
                const normalizedBase = cwd.replace(RE_BACKSLASH, '/').replace(RE_TRAILING_SLASH, '')
                // The listing's paths are relative to the fs root; a location under the absolute
                // root (`/…`) keeps its slash in front of them.
                const rootSlash = isRemote && normalizedBase.startsWith('/') ? '/' : ''
                const nextItems = result
                    .map((item) => {
                        const relativePath = String(item.Path || item.Name || '').replace(
                            RE_LEADING_SLASH,
                            ''
                        )
                        const name = String(item.Name || relativePath.split('/').pop() || '')
                        if (
                            !relativePath ||
                            !name ||
                            relativePath.split('/').some((part) => part.startsWith('.')) ||
                            !name.toLowerCase().includes(lowerTerm)
                        ) {
                            return null
                        }

                        const relativeToRoot = normalizedBase
                            ? `${normalizedBase}/${relativePath}`
                            : relativePath
                        const fullPath =
                            selectedRemote === 'UI_LOCAL_FS'
                                ? normalizedBase
                                    ? relativeToRoot
                                    : `/${relativePath}`
                                : serializeRemotePath(
                                      selectedRemote as string,
                                      `${rootSlash}${relativeToRoot.replace(RE_LEADING_SLASH, '')}`
                                  )

                        return {
                            key: fullPath,
                            name,
                            displayName: relativePath,
                            isDir: !!(item.IsDir || item.IsBucket),
                            size: typeof item.Size === 'number' ? item.Size : undefined,
                            modTime: item.ModTime,
                            mimeType: item.MimeType,
                            remote: selectedRemote,
                            fullPath,
                        } as Entry
                    })
                    .filter((item): item is Entry => item !== null)

                startTransition(() => {
                    setRecursiveSearchItems(nextItems)
                    setIsSearching(false)
                })
            } catch {
                if (
                    controller.signal.aborted ||
                    searchRequestSequenceRef.current !== requestSequence
                ) {
                    return
                }
                startTransition(() => {
                    setRecursiveSearchItems([])
                    setSearchError('Unable to search this folder')
                    setIsSearching(false)
                })
            }
        }, 350)

        return () => {
            clearTimeout(timeoutId)
            controller.abort()
        }
    }, [cwd, isActive, searchInSubfolders, searchTerm, searchTick, selectedRemote])

    // Initialize once per activation. The guard is set inside the branches (the remotes branch
    // only once the list has loaded, so late data can still finish the job) — after that, dep
    // churn (e.g. a /config/listremotes refetch minting a new `remotes` identity) can no longer
    // yank live navigation back to the initial location. Deliberately no effect cleanup: the
    // pending home write must land.
    const hasInitializedRef = useRef(false)
    useEffect(() => {
        if (!isActive) {
            // Deactivation re-arms initialization so a closed-and-reopened drawer (PathSelector
            // passes isActive={isOpen}) still resets to its initial location.
            hasInitializedRef.current = false
            return
        }
        if (hasInitializedRef.current) return

        const hasInitial = initialRemote !== undefined
        const needsLocalPath = initialRemote === 'UI_LOCAL_FS' && !initialPath

        if (needsLocalPath || (!hasInitial && canShowLocal)) {
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
            // remotes still loading (empty list): stay uninitialized so the arrival re-run
            // completes the initialization.
            if (remotes.length > 0) {
                hasInitializedRef.current = true
                startTransition(() => {
                    setSelectedRemote(remotes[0])
                    setCwd('')
                })
            }
        } else {
            // hasInitial with a concrete remote/path: state was already seeded by the useState
            // initializers; nothing to apply.
            hasInitializedRef.current = true
        }
    }, [
        isActive,
        canShowLocal,
        canShowFavorites,
        canShowRemotes,
        remotes,
        initialRemote,
        initialPath,
    ])

    // The delayed loading indicator: a listing that answers within 200 ms never shows one; a
    // slow one (a miss, a refresh, a stale folder refetching) does, rows on screen or not.
    useEffect(() => {
        if (!listing.isFetching) {
            setShowLoading(false)
            return
        }
        const timer = setTimeout(() => setShowLoading(true), 200)
        return () => clearTimeout(timer)
    }, [listing.isFetching])

    // A navigation ends when its listing has settled, from the cache or from rclone.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a folder served from the cache never fetches, so the folder itself must re-run this
    useEffect(() => {
        if (!listing.isFetching) isNavigatingRef.current = false
    }, [listing.isFetching, selectedRemote, cwd])

    // Folder sizes come from operations/size, two folders at a time, patched into the cached
    // rows as the numbers arrive and stopped with the folder. Only rows still without a size
    // are asked, so a listing served from the cache starts nothing, and a patch (which keeps
    // the listing's clock) re-runs nothing.
    // biome-ignore lint/correctness/useExhaustiveDependencies: dataUpdatedAt is the re-run trigger, a real fetch; the rows are read from the cache
    useEffect(() => {
        if (!listingEnabled || selectedRemote !== 'UI_LOCAL_FS') return
        const rows = queryClient.getQueryData<Entry[]>(listingKey('UI_LOCAL_FS', cwd))
        const queue = (rows ?? []).filter((row) => row.isDir && row.size === undefined)
        if (queue.length === 0) return
        const controller = new AbortController()
        const pending = new Map<string, number | undefined>()
        let frame: number | null = null
        const flush = () => {
            frame = null
            if (controller.signal.aborted || pending.size === 0) return
            const sizes = new Map(pending)
            pending.clear()
            patchListing('UI_LOCAL_FS', cwd, (current) =>
                current.map((row) =>
                    sizes.has(row.key) ? { ...row, size: sizes.get(row.key) } : row
                )
            )
        }
        const worker = async () => {
            while (queue.length > 0 && !controller.signal.aborted) {
                const row = queue.shift()!
                const size = await folderSize(row.fullPath, controller.signal).catch(
                    () => undefined
                )
                if (controller.signal.aborted) return
                pending.set(row.key, size)
                if (frame === null) frame = requestAnimationFrame(flush)
            }
        }
        void Promise.all([worker(), worker()])
        return () => {
            controller.abort()
            if (frame !== null) cancelAnimationFrame(frame)
        }
    }, [queryClient, listingEnabled, selectedRemote, cwd, listing.dataUpdatedAt])

    useEffect(() => {
        updatePathInput(selectedRemote, cwd)
        setSearchTerm('')
        setPathError(null)
    }, [selectedRemote, cwd, updatePathInput])

    useEffect(() => {
        let cancelled = false
        async function updateUpState() {
            if (!selectedRemote) {
                if (!cancelled) setIsUpDisabled(true)
                return
            }
            if (isRemote) {
                // Each root is the top of its own tree: the login directory, or the machine's `/`.
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
        // State
        selectedRemote,
        cwd,
        pathInput,
        items,
        visibleItems,
        virtualizedItems,
        isLoading,
        isSearching,
        error,
        searchError,
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

        // Actions
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

        // For external control
        setSelectedRemote,
        setCwd,
    }
}
