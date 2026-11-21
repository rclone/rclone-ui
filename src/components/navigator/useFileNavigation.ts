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

/**
 * Orders two names that `compareText` holds equal (they differ only by case or accents), so that
 * the rows keep one order. It follows the app's language too.
 */
const exactCollator = new Intl.Collator(locale())

/**
 * The line under the list about the rows: `active` while they still arrive, `warning` when the
 * panel stopped at its cap.
 */
export interface PanelStatus {
    kind: 'active' | 'warning'
    text: string
}

const EMPTY: Entry[] = []
const NOTHING_HELD: Held<Entry> = { at: null, rows: EMPTY, complete: false }

/**
 * A file panel's state. `initialRemote` and `initialPath` set where it starts. `UI_LOCAL_FS` with
 * no path starts in the home folder, and with an empty path at the list of disks. Without an
 * initial place, the panel starts at home, or with `startAtFirstRemote`, at the root of the first
 * remote (at home when there are none). `initialSort` and `initialSelection` restore how the
 * panel was left (the Commander's).
 */
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
    // Sorted like every list of remotes. The names are joined so that the list keeps its identity
    // when only a remote's fsinfo changes.
    const remoteNames = namesOf(configured).join('\n')
    const remotes = useMemo(() => (remoteNames ? remoteNames.split('\n') : []), [remoteNames])
    // Whether the list of remotes has been read, so an empty list means there are none.
    const remotesKnown = remotesQuery.isSuccess
    const remotesSettled = remotesQuery.isSuccess || remotesQuery.isError

    const [selectedRemote, setSelectedRemote] = useState<RemoteString>(initialRemote ?? null)
    const [cwd, setCwd] = useState<string>(initialPath ?? '')
    const [pathInput, setPathInput] = useState<string>('')
    const [searchTerm, setSearchTerm] = useState<string>('')
    const [searchInSubfolders, setSearchInSubfolders] = useState(false)
    const [sortDescriptor, setSortDescriptor] = useState<Sort>(initialSort)
    // The reason the path bar refused a path (`pathProblem`). A failed listing reports its own
    // error through the listing job.
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

    // The selection is one ordered map from each path to its type, so a path and its type can't
    // get out of step.
    const [selected, setSelected] = useState<Selection>(
        () => new Map((initialSelection ?? []).map((item) => [item.path, item.type]))
    )
    // The panel's table expects a set of keys, so the set is derived from the map.
    const selectedPaths = useMemo(() => new Set(selected.keys()), [selected])

    // The folder's rows come from the core's listing, which the core caches per folder. They are
    // sent in pieces and collected here as they arrive. Favorites are built from the core's list
    // instead, and the roots of the local sidebar have no folder to list.
    const isFavorites = selectedRemote === 'UI_FAVORITES'
    const listingEnabled =
        isActive && !!selectedRemote && !isFavorites && !(selectedRemote === 'UI_LOCAL_FS' && !cwd)
    const location = useMemo(
        () => (listingEnabled ? panelFolder(selectedRemote, cwd) : null),
        [listingEnabled, selectedRemote, cwd]
    )
    // Turning File dates on or off changes the arguments, so the folder is listed again.
    const [fileDates] = useFileDates()
    const listing = useJob<Browse.Row>('list', location ? { path: location, fileDates } : null, {
        cap: LIST_CAP,
    })
    // Whether the listing's rows belong to the folder shown. Just after a folder change they still
    // belong to the previous folder, because the job starts after the render. Showing them as the
    // new folder's rows would list entries that aren't in it.
    const current = location !== null && listing.args?.path === location

    // Folder sizes are computed for local folders only, unless the user turned them off
    // (`folderSizes.ts`).
    const sizes = useFolderSizeJob(
        listing,
        current && selectedRemote === 'UI_LOCAL_FS' ? location : null
    )

    const listed = useMemo(
        () => (current ? toEntries(listing.items, selectedRemote as string, { sizes }) : EMPTY),
        [current, listing.items, selectedRemote, sizes]
    )
    // The previous folder stays on screen, with its own paths, until the next folder's rows start
    // to arrive. A failed listing clears it. The folder shown, listed again (a refresh, or a
    // change in it), keeps its rows until the new listing ends (`relisting`).
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
    // A failed listing doesn't show the previous folder, and a disabled one shows nothing.
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
    // "Loading..." replaces the list, so it is only for another folder, never for the one shown.
    // `waiting` is checked too, because the effect that clears `showLoading` runs a render after
    // the rows arrive, and that render would unmount the list.
    const isLoading = showLoading && waiting && !refreshing

    // When rclone reports that the remote's sign-in expired, offer to reconnect, then list the
    // folder again.
    const refreshListing = listing.refresh
    useReconnectOffer(listing.reconnect, refreshListing)

    // List the folder again when the page changes something in it, or when a transfer into it
    // ends. A config change also lists a remote folder again (the core returns its cache when
    // nothing changed there), but it can't affect a local folder. A resync after missed events
    // lists it again too, because a change might have happened in the gap.
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

    // Searching in subfolders runs the core's search 350 ms after typing stops. A new term
    // cancels the old search. Matches are shown as the search finds them.
    const [typedTerm] = useDebounce(searchTerm.trim(), 350)
    const searchLocation = useMemo(() => panelFolder(selectedRemote, cwd), [selectedRemote, cwd])
    const searchJob = useJob<Browse.Row>(
        'search',
        isActive && recursiveSearchActive && typedTerm && searchLocation
            ? { path: searchLocation, q: typedTerm, fileDates }
            : null,
        { cap: SEARCH_CAP }
    )
    // As with the listing, only show matches found under the folder shown.
    const recursiveSearchItems = useMemo(
        () =>
            searchLocation && searchJob.phase !== 'idle' && searchJob.args?.path === searchLocation
                ? toEntries(searchJob.items, selectedRemote as string, { search: true })
                : null,
        [searchLocation, searchJob.phase, searchJob.args, searchJob.items, selectedRemote]
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
            // The count is the search's cap, so it is always the same large number.
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
            // The count is the panel's cap, so it is always the same large number.
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
        // A folder picker also lists files, as rows that can't be picked. Both modes use the
        // same listing, so the counts and the cap match, and a folder that holds only files
        // isn't shown as empty.
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
        // A favorite is a full path, kept as it was saved. A leading slash means the absolute root.
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

    // The panel's refresh button. It lists the folder from rclone again, however recent the
    // cached listing is (`fresh`), and runs the search in it again.
    const refresh = useCallback(() => {
        setPathError(null)
        refreshListing()
        refreshSearchJob()
    }, [refreshListing, refreshSearchJob])

    const navigateTo = useCallback(
        (path: string) => {
            // `~` stands for the home folder, as in a shell. The path isn't trimmed: a crumb or
            // "Show in panel" gives a folder's exact path, whose name may end with a space. The
            // path field trims what is typed (PathBreadcrumb).
            const value = expandHome(path, home, isWindows())
            if (!value) return
            // The path is read the way rclone reads it (`lib/paths.ts`). `remote:folder` is a
            // remote, and `C:\Users` is a drive on a Windows host. A path that rclone would refuse,
            // or would read differently than intended, is reported here and not opened. So is a
            // remote that isn't configured, before anything tries to list it.
            const problem =
                pathProblem(value) ?? unknownRemote(value, remotesKnown ? remotes : undefined)
            if (problem) {
                setPathError(problem)
                return
            }
            const { remote: nextRemote, cwd: nextCwd } = placeOf(value)
            // The user entered the folder the panel already shows (after a refused path, for
            // example). No state would change, so nothing would reload. Refresh instead, since
            // that is what the user meant.
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

    // What is inside a selected folder is already selected, so ticking it is refused
    // (`selection.ts`). This is checked outside the state update, so the toast shows once.
    const handleToggleSelect = useCallback(
        (entry: Entry) => {
            // A folder picker shows files but can't select them.
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
                    // A single-selection picker keeps only the first selected row.
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

    /**
     * Removes entries from the selection, such as a row that was renamed, deleted or moved away,
     * with whatever is selected inside them: those paths no longer exist either.
     */
    const deselect = useCallback((keys: string[]) => {
        startTransition(() =>
            setSelected((prev) => {
                const next = new Map(prev)
                for (const key of keys) removeFrom(next, key)
                return next.size === prev.size ? prev : next
            })
        )
    }, [])

    // Items inside a selected folder are skipped, and the toast says why.
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

    // Initialize once per activation. Each branch sets the guard itself. The remotes branch sets
    // it only once a remote exists, so a remote added later can still complete the
    // initialization. After that, a dependency change (such as a reload of the shared `remotes`
    // that creates a new list) can't move the user back to the initial location. There is no
    // cleanup on purpose, because the pending state update for the home folder must still apply.
    const hasInitializedRef = useRef(false)
    useEffect(() => {
        if (!isActive) {
            // Deactivating resets the guard, so a drawer that is closed and opened again
            // (PathSelector passes isActive={isOpen}) goes back to its initial location.
            hasInitializedRef.current = false
            return
        }
        if (hasInitializedRef.current) return

        const hasInitial = initialRemote !== undefined
        // An empty path is the list of disks. A panel that was left there reopens there.
        const needsLocalPath = initialRemote === 'UI_LOCAL_FS' && initialPath === undefined

        if (!hasInitial && startAtFirstRemote && canShowRemotes) {
            // Wait for the list of remotes. With none (or when it can't be read), start at home.
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
            // With no remotes yet, stay uninitialized so that the effect completes the
            // initialization when the first remote arrives.
            if (remotes.length > 0) {
                hasInitializedRef.current = true
                startTransition(() => {
                    setSelectedRemote(remotes[0])
                    setCwd('')
                })
            }
        } else {
            // An initial remote and path were given, and the useState initializers already
            // applied them.
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

    // The loading indicator is delayed. A listing that returns within 200 ms never shows it. A
    // slower one (a cache miss or a refresh) shows it until the first rows arrive, and then the
    // status line shows the count.
    useEffect(() => {
        if (!waiting) {
            setShowLoading(false)
            return
        }
        const timer = setTimeout(() => setShowLoading(true), 200)
        return () => clearTimeout(timer)
    }, [waiting])

    // A navigation ends once the rows shown belong to the new folder, which means its listing
    // has sent some rows or has finished. Until then the screen still shows the previous folder,
    // whose entries aren't in the new one. It doesn't wait for the whole folder, because then a
    // large folder would ignore clicks until its last row arrived.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a folder served at once is never waited for, so the folder itself must re-run this
    useEffect(() => {
        if (!waiting) isNavigatingRef.current = false
    }, [waiting, selectedRemote, cwd])

    useEffect(() => {
        updatePathInput(selectedRemote, cwd)
        setSearchTerm('')
        setPathError(null)
    }, [selectedRemote, cwd, updatePathInput])

    // A single-selection picker selects from the folder it shows. A selection left over from the
    // parent folder would disable every row here, and the picker would return it even though it
    // is no longer on screen.
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
                // Both roots are the top of their own tree: '' is the login folder, and '/' is
                // the root of the machine.
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
