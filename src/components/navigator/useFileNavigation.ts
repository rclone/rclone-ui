import { useQuery } from '@tanstack/react-query'
import { Channel, invoke } from '@tauri-apps/api/core'
import { homeDir } from '@tauri-apps/api/path'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import rclone from '../../../lib/rclone/client.ts'
import { useHostStore } from '../../../store/host.ts'
import { useCurrentHost, usePersistedStore } from '../../../store/persisted.ts'
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
    isHiddenRelativePath,
    joinLocal,
    listRemotePath,
    log,
    searchPath,
    serializeRemotePath,
} from './utils'

const nameCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
})

export default function useFileNavigation({
    initialRemote,
    initialPath,
    allowedKeys = ['REMOTES', 'LOCAL_FS', 'FAVORITES'],
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
    const favoritePaths = useHostStore((state) => state.favoritePaths)
    const currentHost = useCurrentHost()
    const showHidden = usePersistedStore((state) => state.showHiddenFiles)
    const setShowHiddenFiles = usePersistedStore((state) => state.setShowHiddenFiles)

    const toggleShowHidden = useCallback(() => {
        setShowHiddenFiles(!showHidden)
    }, [setShowHiddenFiles, showHidden])

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
    const localCompleteCacheRef = useRef<Set<string>>(new Set())
    const entryByKeyRef = useRef<Map<string, Entry>>(new Map())
    const abortControllerRef = useRef<AbortController | null>(null)
    const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isNavigatingRef = useRef(false)
    const localRequestIdRef = useRef<string | null>(null)
    const localRequestPrefixRef = useRef(Math.random().toString(36).slice(2))
    const localRequestSequenceRef = useRef(0)
    const searchRequestSequenceRef = useRef(0)

    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
    const selectedTypesRef = useRef<Map<string, 'file' | 'folder'>>(new Map())

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
            const normalizedA =
                aValue !== undefined && Number.isFinite(aValue) ? aValue : undefined
            const normalizedB =
                bValue !== undefined && Number.isFinite(bValue) ? bValue : undefined

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
    }, [
        allowFiles,
        items,
        recursiveSearchActive,
        recursiveSearchItems,
        searchTerm,
        sortDescriptor,
    ])

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
            isSelected: selectedPaths.has(item.key),
        }))
        for (let i = 0; i < VIRTUAL_PADDING_COUNT; i++) {
            base.push({ key: `__padding-${i}`, padding: true })
        }
        return base
    }, [visibleItems, selectedPaths])

    const selectedCount = useMemo(() => selectedPaths.size, [selectedPaths])

    const favoritedKeys = useMemo(() => {
        const map: Record<string, boolean> = {}
        for (const it of favoritePaths || []) {
            const remote = (it as any).remote as string | undefined
            const rawPath = (it as any).path as string
            let fullKey = rawPath
            if (rawPath?.includes(':/')) {
                fullKey = rawPath
            } else if (remote && remote !== 'UI_LOCAL_FS') {
                const rel = (rawPath || '').replace(RE_LEADING_SLASH, '')
                fullKey = serializeRemotePath(remote, rel)
            } else {
                fullKey = rawPath
            }
            if (fullKey) map[fullKey] = true
        }
        return map
    }, [favoritePaths])

    const cleanupSelectionForRemote = useCallback(
        (newRemote: RemoteString) => {
            log('cleanupSelectionForRemote', { newRemote, selectedRemote })
            if (newRemote !== selectedRemote) {
                startTransition(() => {
                    setSelectedPaths(new Set())
                })
                selectedTypesRef.current.clear()
                const currentPrefix = selectedRemote === 'UI_LOCAL_FS' ? '' : `${selectedRemote}:`
                const keysToRemove: string[] = []
                for (const key of entryByKeyRef.current.keys()) {
                    if (selectedRemote === 'UI_LOCAL_FS' && !key.includes(':/')) {
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
            startTransition(() => setPathInput(`${nextRemote}:/${nextCwd || ''}`))
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
                if (full.includes(':/')) {
                    const [remoteName, ...rest] = full.split(':/')
                    const rel = rest.join('/')
                    cleanupSelectionForRemote(remoteName as any)
                    startTransition(() => {
                        setSelectedRemote(remoteName as any)
                        setCwd(rel)
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
                const resultPath = isRemote
                    ? entry.fullPath.split(':/').slice(1).join('/')
                    : entry.fullPath
                startTransition(() => setCwd(resultPath))
                return
            }
            if (isRemote) {
                const base = cwd ? `${cwd}/` : ''
                startTransition(() => setCwd(`${base}${entry.name}`))
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
            if (value.includes(':/')) {
                const [remote, ...rest] = value.split(':/')
                const rel = rest.join('/')
                cleanupSelectionForRemote(remote)
                startTransition(() => {
                    setSelectedRemote(remote)
                    setCwd(rel)
                })
            } else {
                cleanupSelectionForRemote('UI_LOCAL_FS')
                startTransition(() => {
                    setSelectedRemote('UI_LOCAL_FS')
                    setCwd(value)
                })
            }
        },
        [cleanupSelectionForRemote]
    )

    const selectRemote = useCallback(
        async (remote: string | 'UI_LOCAL_FS' | 'UI_FAVORITES', initialPath?: string) => {
            cleanupSelectionForRemote(remote)
            if (remote === 'UI_LOCAL_FS') {
                const startPath = initialPath ?? (await homeDir())
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
            const next = new Set(selectedPaths)
            if (next.has(entry.key)) {
                next.delete(entry.key)
                selectedTypesRef.current.delete(entry.key)
            } else {
                if (!allowMultiple && next.size > 0) return
                next.add(entry.key)
                selectedTypesRef.current.set(entry.key, entry.isDir ? 'folder' : 'file')
            }
            startTransition(() => setSelectedPaths(next))
        },
        [selectedPaths, allowMultiple]
    )

    const getSelection = useCallback((): SelectItem[] => {
        const paths = Array.from(selectedPaths)
        return paths.map((path) => {
            const known = selectedTypesRef.current.get(path)
            if (known) return { path, type: known }
            const entry = entryByKeyRef.current.get(path)
            if (entry) return { path, type: entry.isDir ? 'folder' : 'file' }
            if (path.includes(':/')) {
                const rel = path.split(':/').slice(1).join('/')
                return { path, type: rel.endsWith('/') ? 'folder' : 'file' }
            }
            return { path, type: 'file' }
        })
    }, [selectedPaths])

    const clearSelection = useCallback(() => {
        selectedTypesRef.current.clear()
        startTransition(() => setSelectedPaths(new Set()))
    }, [])

    const selectAll = useCallback(
        (type: 'files' | 'folders' | 'all') => {
            const next = new Set(selectedPaths)
            for (const item of visibleItems) {
                if (type === 'files' && !item.isDir) {
                    next.add(item.key)
                    selectedTypesRef.current.set(item.key, 'file')
                } else if (type === 'folders' && item.isDir) {
                    next.add(item.key)
                    selectedTypesRef.current.set(item.key, 'folder')
                } else if (type === 'all') {
                    next.add(item.key)
                    selectedTypesRef.current.set(item.key, item.isDir ? 'folder' : 'file')
                }
            }
            startTransition(() => setSelectedPaths(next))
        },
        [selectedPaths, visibleItems]
    )

    const refresh = useCallback(() => {
        for (const hiddenState of [false, true]) {
            const key = cacheKey(selectedRemote, cwd, hiddenState)
            cacheRef.current.delete(key)
            localCompleteCacheRef.current.delete(key)
        }
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
                const normalizedBase = cwd
                    .replace(RE_BACKSLASH, '/')
                    .replace(RE_TRAILING_SLASH, '')
                const nextItems = result
                    .map((item) => {
                        const relativePath = String(item.Path || item.Name || '')
                            .replace(RE_LEADING_SLASH, '')
                        const name = String(item.Name || relativePath.split('/').pop() || '')
                        if (
                            !relativePath ||
                            !name ||
                            (!showHidden && isHiddenRelativePath(relativePath)) ||
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
                                : serializeRemotePath(selectedRemote as string, relativeToRoot)

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
    }, [
        currentHost?.id,
        cwd,
        isActive,
        searchInSubfolders,
        searchTerm,
        refreshKey,
        selectedRemote,
        showHidden,
    ])

    // Initialize once per activation. The guard is set inside the branches (the remotes branch
    // only once the list has loaded, so late data can still finish the job) — after that, dep
    // churn (e.g. a /config/listremotes refetch minting a new `remotes` identity) can no longer
    // yank live navigation back to the initial location. Deliberately no effect cleanup:
    // cancelling the pending homeDir() write would strand the panel on isLoading.
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
            homeDir().then((home) => {
                startTransition(() => {
                    setSelectedRemote('UI_LOCAL_FS')
                    setCwd(home)
                    setPathInput(home)
                })
                setIsLoading(false)
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

    // Load directory content when remote/cwd changes
    // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional re-run trigger the body doesn't read — refresh() evicts the cacheRef entry, clears items, and bumps it to force a refetch of the current directory; removing it breaks the Refresh button (empty panel, isLoading stuck true)
    useEffect(() => {
        if (!isActive) return
        const cKey = cacheKey(selectedRemote, cwd, showHidden)

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
                if (
                    selectedRemote === 'UI_LOCAL_FS' &&
                    localCompleteCacheRef.current.has(cKey)
                ) {
                    finished = true
                    if (loadingTimerRef.current) {
                        clearTimeout(loadingTimerRef.current)
                        loadingTimerRef.current = null
                    }
                    setIsLoading(false)
                    return
                }
            }

            let nextItems: Entry[] = []
            if (selectedRemote === 'UI_FAVORITES') {
                nextItems = (favoritePaths || []).map((fav) => {
                    const remote = (fav as any).remote as string | undefined
                    const isLocal = !remote || remote === 'UI_LOCAL_FS'
                    const rawPath = (fav as any).path as string
                    let fullPath = rawPath
                    if (!isLocal) {
                        if (rawPath.includes(':/')) {
                            fullPath = rawPath
                        } else {
                            const rel = (rawPath || '').replace(RE_LEADING_SLASH, '')
                            fullPath = serializeRemotePath(remote!, rel)
                        }
                    }
                    const relForName = (() => {
                        if (!isLocal) {
                            if (rawPath.includes(':/'))
                                return rawPath.split(':/').slice(1).join('/')
                            return rawPath
                        }
                        return rawPath
                    })()
                    const normalized = (relForName || '')
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
                })
                nextItems.sort((a, b) => a.name.localeCompare(b.name))
                if (!controller.signal.aborted) {
                    finished = true
                    if (loadingTimerRef.current) {
                        clearTimeout(loadingTimerRef.current)
                        loadingTimerRef.current = null
                    }
                    cacheRef.current.set(cKey, nextItems)
                    const map = entryByKeyRef.current
                    for (const e of nextItems) map.set(e.key, e)
                    startTransition(() => {
                        setItems(nextItems)
                        setIsLoading(false)
                    })
                    isNavigatingRef.current = false
                }
                return
            }

            if (isRemote) {
                log('loadDir: fetching remote')
                const remote = selectedRemote as string
                const targetCwd = cwd || ''
                let listedItems: { list: any[] } | null = null
                try {
                    listedItems = await listRemotePath(remote, targetCwd, {
                        noModTime: false,
                        noMimeType: true,
                    })
                } catch (_err: unknown) {
                    if (!controller.signal.aborted) {
                        finished = true
                        if (loadingTimerRef.current) {
                            clearTimeout(loadingTimerRef.current)
                            loadingTimerRef.current = null
                        }
                        startTransition(() => {
                            setIsLoading(false)
                            setItems([])
                            setError('No access or folder does not exist')
                        })
                        isNavigatingRef.current = false
                    }
                    return
                }

                if (controller.signal.aborted) {
                    log('loadDir: aborted after fetch')
                    return
                }

                nextItems = (listedItems?.list || [])
                    .map((it) => {
                        const rel = (it.Path || it.Name || '') as string
                        const baseName = rel.split('/').pop() || ''
                        const isDir = !!(it.IsDir || (it as any).IsBucket)
                        const full = serializeRemotePath(remote, rel)
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
                    .filter((e) => e.name && (showHidden || !e.name.startsWith('.')))
            } else if (cwd) {
                const requestId = `${localRequestPrefixRef.current}-${++localRequestSequenceRef.current}`
                localRequestIdRef.current = requestId
                let streamedItems: Entry[] = []
                let streamedIndexes = new Map<string, number>()
                const pendingSizes = new Map<string, number | undefined>()
                let sizeFrame: number | null = null
                let streamFailed = false
                const channel = new Channel<
                    | {
                          event: 'entries'
                          entries: {
                              name: string
                              fullPath: string
                              isDir: boolean
                              size: number | null
                              modTime: string | null
                          }[]
                      }
                    | { event: 'size'; fullPath: string; size: number | null }
                    | { event: 'error'; message: string }
                    | { event: 'complete' }
                >()
                const cancelSizeFrame = () => {
                    if (sizeFrame !== null) cancelAnimationFrame(sizeFrame)
                    sizeFrame = null
                }
                const flushSizeUpdates = () => {
                    if (controller.signal.aborted || pendingSizes.size === 0) {
                        pendingSizes.clear()
                        return
                    }

                    const nextItems = [...streamedItems]
                    for (const [fullPath, size] of pendingSizes) {
                        const index = streamedIndexes.get(fullPath)
                        if (index === undefined) continue
                        const updated = { ...nextItems[index], size }
                        nextItems[index] = updated
                        entryByKeyRef.current.set(updated.key, updated)
                    }
                    pendingSizes.clear()
                    streamedItems = nextItems
                    cacheRef.current.set(cKey, streamedItems)
                    startTransition(() => setItems(streamedItems))
                }
                try {
                    await new Promise<void>((resolve, reject) => {
                        channel.onmessage = (event) => {
                            if (event.event === 'complete') {
                                cancelSizeFrame()
                                flushSizeUpdates()
                                if (!controller.signal.aborted && !streamFailed) {
                                    localCompleteCacheRef.current.add(cKey)
                                }
                                if (localRequestIdRef.current === requestId) {
                                    localRequestIdRef.current = null
                                }
                                resolve()
                                return
                            }
                            if (controller.signal.aborted) return
                            if (event.event === 'error') {
                                streamFailed = true
                                cancelSizeFrame()
                                pendingSizes.clear()
                                cacheRef.current.delete(cKey)
                                localCompleteCacheRef.current.delete(cKey)
                                reject(new Error(event.message))
                                return
                            }
                            if (event.event === 'entries') {
                                streamedItems = event.entries.map(
                                    (entry) =>
                                        ({
                                            key: entry.fullPath,
                                            name: entry.name,
                                            isDir: entry.isDir,
                                            size: entry.size ?? undefined,
                                            modTime: entry.modTime ?? undefined,
                                            remote: 'UI_LOCAL_FS',
                                            fullPath: entry.fullPath,
                                        }) as Entry
                                )
                                streamedItems.sort((a, b) => {
                                    if (a.isDir && !b.isDir) return -1
                                    if (!a.isDir && b.isDir) return 1
                                    return a.name.localeCompare(b.name)
                                })
                                streamedIndexes = new Map(
                                    streamedItems.map((entry, index) => [entry.fullPath, index])
                                )
                                finished = true
                                if (loadingTimerRef.current) {
                                    clearTimeout(loadingTimerRef.current)
                                    loadingTimerRef.current = null
                                }
                                cacheRef.current.set(cKey, streamedItems)
                                localCompleteCacheRef.current.delete(cKey)
                                const map = entryByKeyRef.current
                                for (const entry of streamedItems) map.set(entry.key, entry)
                                setItems(streamedItems)
                                setIsLoading(false)
                                isNavigatingRef.current = false
                                return
                            }

                            pendingSizes.set(event.fullPath, event.size ?? undefined)
                            if (sizeFrame === null) {
                                sizeFrame = requestAnimationFrame(() => {
                                    sizeFrame = null
                                    flushSizeUpdates()
                                })
                            }
                        }

                        invoke<void>('list_local_directory', {
                            path: cwd,
                            requestId,
                            showHidden,
                            onEvent: channel,
                        }).catch(reject)
                    })
                } catch {
                    cacheRef.current.delete(cKey)
                    localCompleteCacheRef.current.delete(cKey)
                    if (!controller.signal.aborted) {
                        finished = true
                        if (loadingTimerRef.current) {
                            clearTimeout(loadingTimerRef.current)
                            loadingTimerRef.current = null
                        }
                        setIsLoading(false)
                        setItems([])
                        setError('No access or folder does not exist')
                        isNavigatingRef.current = false
                    }
                    return
                } finally {
                    cancelSizeFrame()
                    pendingSizes.clear()
                    if (localRequestIdRef.current === requestId) {
                        localRequestIdRef.current = null
                    }
                }

                return
            } else {
                nextItems = []
            }

            if (controller.signal.aborted) return

            nextItems.sort((a, b) => {
                if (a.isDir && !b.isDir) return -1
                if (!a.isDir && b.isDir) return 1
                return a.name.localeCompare(b.name)
            })

            if (!controller.signal.aborted) {
                finished = true
                if (loadingTimerRef.current) {
                    clearTimeout(loadingTimerRef.current)
                    loadingTimerRef.current = null
                }
                cacheRef.current.set(cKey, nextItems)
                const map = entryByKeyRef.current
                for (const e of nextItems) map.set(e.key, e)
                setItems(nextItems)
                setIsLoading(false)
                isNavigatingRef.current = false
            }
        }

        loadDir()

        return () => {
            if (abortControllerRef.current) abortControllerRef.current.abort()
            if (localRequestIdRef.current) {
                cacheRef.current.delete(cKey)
                localCompleteCacheRef.current.delete(cKey)
                invoke('cancel_local_directory', {
                    requestId: localRequestIdRef.current,
                }).catch(() => {})
                localRequestIdRef.current = null
            }
            if (loadingTimerRef.current) {
                clearTimeout(loadingTimerRef.current)
                loadingTimerRef.current = null
            }
        }
    }, [selectedRemote, cwd, isRemote, favoritePaths, isActive, refreshKey, showHidden])

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
                if (!cancelled) setIsUpDisabled(cwd === '')
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
        showHidden,

        // Actions
        setPathInput,
        setSearchTerm,
        setSearchInSubfolders,
        toggleShowHidden,
        handleSort,
        handleNavigate,
        navigateUp,
        navigateTo,
        selectRemote,
        handleToggleSelect,
        getSelection,
        clearSelection,
        selectAll,
        refresh,
        entryByKeyRef,

        // For external control
        setSelectedRemote,
        setCwd,
        setSelectedPaths,
    }
}
