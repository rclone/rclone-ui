import { useQuery } from '@tanstack/react-query'

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
    cacheKey,
    getLocalParent,
    getRemoteParent,
    joinLocal,
    listPath,
    log,
    parseRemotePath,
    resolveFs,
    searchPath,
    serializeRemotePath,
} from './utils'
import { isRemote as isRemotePath, joinRemoteDir, parsePath, pathProblem } from '@/lib/paths'
import { folderSize, localFs } from '@/lib/rclone/daemon-fs'
import { home } from '@/server/boot'
import { hostSeparator } from '@/lib/rclone/client'

const nameCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
})

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
    const [items, setItems] = useState<Entry[]>([])
    const [isLoading, setIsLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)
    const [isUpDisabled, setIsUpDisabled] = useState(false)
    const [refreshKey, setRefreshKey] = useState(0)

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

    const cacheRef = useRef<Map<string, Entry[]>>(new Map())
    const entryByKeyRef = useRef<Map<string, Entry>>(new Map())
    const abortControllerRef = useRef<AbortController | null>(null)
    const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isNavigatingRef = useRef(false)
    const searchRequestSequenceRef = useRef(0)

    // The selection is one ordered map: the path, and what it is. It used to be a set of paths
    // beside a ref holding their types, which every operation that touched one had to touch in
    // step with the other.
    const [selected, setSelected] = useState<Map<string, 'file' | 'folder'>>(new Map())
    // The panel's table takes a set of keys, so the set is derived rather than kept.
    const selectedPaths = useMemo(() => new Set(selected.keys()), [selected])

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

    const virtualizedItems: (VirtualizedEntry | PaddingItem)[] = useMemo(() => {
        const base: (VirtualizedEntry | PaddingItem)[] = visibleItems.map((item) => ({
            ...item,
            isSelected: selected.has(item.key),
        }))
        for (let i = 0; i < VIRTUAL_PADDING_COUNT; i++) {
            base.push({ key: `__padding-${i}`, padding: true })
        }
        return base
    }, [visibleItems, selected])

    const selectedCount = selected.size

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

    const cleanupSelectionForRemote = useCallback(
        (newRemote: RemoteString) => {
            log('cleanupSelectionForRemote', { newRemote, selectedRemote })
            if (newRemote !== selectedRemote) {
                startTransition(() => {
                    setSelected(new Map())
                })
                const currentPrefix = selectedRemote === 'UI_LOCAL_FS' ? '' : `${selectedRemote}:`
                const keysToRemove: string[] = []
                for (const key of entryByKeyRef.current.keys()) {
                    if (selectedRemote === 'UI_LOCAL_FS' && !isRemotePath(key)) {
                        keysToRemove.push(key)
                    } else if (selectedRemote !== 'UI_LOCAL_FS' && key.startsWith(currentPrefix)) {
                        keysToRemove.push(key)
                    }
                }
                for (const key of keysToRemove) {
                    entryByKeyRef.current.delete(key)
                }
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

    const navigateTo = useCallback(
        (path: string) => {
            const value = path.trim()
            if (!value) return
            // rclone's own reading of the string (`lib/paths.ts`): `remote:folder` is the remote,
            // `C:\Users` is a drive on a Windows host. What rclone would refuse, or would read as
            // something else than meant, is said here and goes nowhere.
            const problem = pathProblem(value)
            if (problem) {
                setError(problem)
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
                setError(null)
                setRefreshKey((k) => k + 1)
                return
            }
            cleanupSelectionForRemote(nextRemote)
            startTransition(() => {
                setSelectedRemote(nextRemote)
                setCwd(nextCwd)
            })
        },
        [cleanupSelectionForRemote, selectedRemote, cwd]
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

    const refresh = useCallback(() => {
        const cKey = cacheKey(selectedRemote, cwd)
        cacheRef.current.delete(cKey)
        startTransition(() => setItems([]))
        setIsLoading(true)
        setRefreshKey((k) => k + 1)
    }, [selectedRemote, cwd])

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

                const map = entryByKeyRef.current
                for (const entry of nextItems) map.set(entry.key, entry)
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
    }, [cwd, isActive, searchInSubfolders, searchTerm, refreshKey, selectedRemote])

    // Initialize once per activation. The guard is set inside the branches (the remotes branch
    // only once the list has loaded, so late data can still finish the job) — after that, dep
    // churn (e.g. a /config/listremotes refetch minting a new `remotes` identity) can no longer
    // yank live navigation back to the initial location. Deliberately no effect cleanup:
    // cancelling the pending home write would strand the panel on isLoading.
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
            setIsLoading(true)
            startTransition(() => {
                setSelectedRemote('UI_LOCAL_FS')
                setCwd(home)
                setPathInput(home)
            })
            setIsLoading(false)
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

    // Load directory content when remote/cwd changes
    // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional re-run trigger the body doesn't read — refresh() evicts the cacheRef entry, clears items, and bumps it to force a refetch of the current directory; removing it breaks the Refresh button (empty panel, isLoading stuck true)
    useEffect(() => {
        if (!isActive) return
        const cKey = cacheKey(selectedRemote, cwd)

        async function loadDir() {
            log('loadDir: start', { selectedRemote, cwd, isRemote })
            if (!selectedRemote) {
                startTransition(() => {
                    setItems([])
                    setError(null)
                    setIsLoading(false)
                })
                isNavigatingRef.current = false
                return
            }

            if (abortControllerRef.current) abortControllerRef.current.abort()
            if (loadingTimerRef.current) {
                clearTimeout(loadingTimerRef.current)
                loadingTimerRef.current = null
            }

            const controller = new AbortController()
            abortControllerRef.current = controller

            let finished = false
            setError(null)
            loadingTimerRef.current = setTimeout(() => {
                if (!controller.signal.aborted && !finished) {
                    startTransition(() => setIsLoading(true))
                }
            }, 200)

            if (cacheRef.current.has(cKey)) {
                log('loadDir: cache hit', cKey)
                const cached = cacheRef.current.get(cKey)!
                startTransition(() => setItems(cached))
                isNavigatingRef.current = false
            }

            // Folder sizes come from operations/size, two folders at a time, and stop with the
            // listing. Rows are patched in place as the numbers arrive.
            const loadFolderSizes = (rows: Entry[], signal: AbortSignal) => {
                const queue = rows.filter((row) => row.isDir)
                if (queue.length === 0) return
                let current = rows
                const pending = new Map<string, number | undefined>()
                let frame: number | null = null
                const flush = () => {
                    frame = null
                    if (signal.aborted || pending.size === 0) return
                    const next = current.map((row) =>
                        pending.has(row.key) ? { ...row, size: pending.get(row.key) } : row
                    )
                    pending.clear()
                    current = next
                    for (const row of next) entryByKeyRef.current.set(row.key, row)
                    cacheRef.current.set(cKey, next)
                    startTransition(() => setItems(next))
                }
                const worker = async () => {
                    while (queue.length > 0 && !signal.aborted) {
                        const row = queue.shift()!
                        const size = await folderSize(row.fullPath, signal).catch(() => undefined)
                        if (signal.aborted) return
                        pending.set(row.key, size)
                        if (frame === null) frame = requestAnimationFrame(flush)
                    }
                }
                void Promise.all([worker(), worker()])
            }

            // A listing settles exactly once, whichever way it goes: the delayed spinner must
            // not fire after the rows, or the error, are already in.
            const settle = () => {
                finished = true
                if (loadingTimerRef.current) {
                    clearTimeout(loadingTimerRef.current)
                    loadingTimerRef.current = null
                }
            }

            // Every failure ends here, whatever the source. The folder's cached rows go with it,
            // so a retry cannot paint the old contents before it refetches.
            const fail = (message: string) => {
                if (controller.signal.aborted) return
                settle()
                cacheRef.current.delete(cKey)
                startTransition(() => {
                    setItems([])
                    setError(message)
                    setIsLoading(false)
                })
                isNavigatingRef.current = false
            }

            // ...and every success here: folders first, then by name, cached, and indexed by key.
            const commit = (rows: Entry[], { sizes }: { sizes: boolean }) => {
                if (controller.signal.aborted) return
                settle()
                rows.sort((a, b) => {
                    if (a.isDir && !b.isDir) return -1
                    if (!a.isDir && b.isDir) return 1
                    return a.name.localeCompare(b.name)
                })
                cacheRef.current.set(cKey, rows)
                for (const row of rows) entryByKeyRef.current.set(row.key, row)
                startTransition(() => {
                    setItems(rows)
                    setIsLoading(false)
                })
                isNavigatingRef.current = false
                if (sizes) loadFolderSizes(rows, controller.signal)
            }

            // Favorites are held in the persisted document, so the rows are built, never fetched.
            if (selectedRemote === 'UI_FAVORITES') {
                commit(
                    (favoritePaths || []).map((fav) => {
                        const remote = (fav as any).remote as string | undefined
                        const isLocal = !remote || remote === 'UI_LOCAL_FS'
                        const rawPath = (fav as any).path as string
                        // Kept under its remote as the user had it (a leading slash is the
                        // absolute root).
                        const fullPath = isLocal
                            ? rawPath
                            : serializeRemotePath(remote!, rawPath || '')
                        const normalized = (rawPath || '')
                            .replace(RE_BACKSLASH, '/')
                            .replace(RE_TRAILING_SLASH, '')
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
                    }),
                    { sizes: false }
                )
                return
            }

            // Remote and local are the same request with different row shapes: the remote names
            // its paths, the local machine's come back relative to the filesystem root.
            const listOptions = { noModTime: false, noMimeType: true }
            let listed: any[]

            if (isRemote) {
                log('loadDir: fetching remote')
                const remote = selectedRemote as string
                try {
                    listed = await listPath(remote, cwd || '', listOptions, controller.signal)
                } catch {
                    fail('No access or folder does not exist')
                    return
                }
                if (controller.signal.aborted) {
                    log('loadDir: aborted after fetch')
                    return
                }
                // The listing's paths are relative to the fs root, which is the remote and the
                // slash the location had (`remote:` or `remote:/`): put back in front, no more.
                const { fs: root } = resolveFs(remote, cwd)
                commit(
                    listed
                        .map((it) => {
                            const rel = (it.Path || it.Name || '') as string
                            const baseName = rel.split('/').pop() || ''
                            const isDir = !!(it.IsDir || (it as any).IsBucket)
                            const full = `${root}${rel}`
                            return {
                                key: full,
                                name: baseName,
                                isDir,
                                size: it.Size,
                                modTime: it.ModTime,
                                mimeType: it.MimeType,
                                remote,
                                fullPath: full,
                            } as Entry
                        })
                        .filter((e) => !e.name.startsWith('.')),
                    { sizes: false }
                )
                return
            }

            // The local sidebar's roots have no folder of their own to list yet.
            if (!cwd) {
                commit([], { sizes: false })
                return
            }

            log('loadDir: fetching local through rclone')
            try {
                listed = await listPath('UI_LOCAL_FS', cwd, listOptions, controller.signal)
            } catch {
                fail('No access or folder does not exist')
                return
            }
            if (controller.signal.aborted) {
                log('loadDir: aborted after fetch')
                return
            }
            // rclone reports paths relative to the filesystem root ('/' or a drive); a folder's
            // own Size is its inode, not its contents, so folders wait for a size job.
            const { fs } = localFs(cwd)
            const rootPrefix = fs === ':local:/' ? '/' : fs.slice(':local:'.length)
            commit(
                listed
                    .map((it) => {
                        const rel = String(it.Path || it.Name || '')
                        const name = String(it.Name || rel.split('/').pop() || '')
                        const isDir = !!it.IsDir
                        let fullPath = `${rootPrefix}${rel}`
                        if (hostSeparator() === '\\') fullPath = fullPath.replace(/\//g, '\\')
                        return {
                            key: fullPath,
                            name,
                            isDir,
                            size:
                                !isDir && typeof it.Size === 'number' && it.Size >= 0
                                    ? it.Size
                                    : undefined,
                            modTime: it.ModTime,
                            remote: 'UI_LOCAL_FS',
                            fullPath,
                        } as Entry
                    })
                    .filter((e) => !e.name.startsWith('.')),
                { sizes: true }
            )
        }
        loadDir()

        return () => {
            if (abortControllerRef.current) abortControllerRef.current.abort()
            if (loadingTimerRef.current) {
                clearTimeout(loadingTimerRef.current)
                loadingTimerRef.current = null
            }
        }
    }, [selectedRemote, cwd, isRemote, favoritePaths, isActive, refreshKey])

    useEffect(() => {
        updatePathInput(selectedRemote, cwd)
        setSearchTerm('')
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
        entryByKeyRef,

        // For external control
        setSelectedRemote,
        setCwd,
    }
}
