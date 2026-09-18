import { Divider, Kbd, ScrollShadow, cn } from '@heroui/react'
import { useQueries, useQuery } from '@tanstack/react-query'

import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDebounce } from 'use-debounce'
import { fsInfoQueryOptions } from '../../lib/hooks'
import { fetchMountList, fetchServeList } from '../../lib/rclone/api'
import rclone from '../../lib/rclone/client'

import { type ResolvedToolbarResult, runToolbarEngine } from '../../toolbar/engine'
import type { ToolbarSnapshot } from '../../toolbar/types'
import { usePersistedStore } from '../../store/persisted'
import type { RcloneFeatures } from '../../types/rclone'
import { on as onAppEvent } from '../../lib/api/events'
import {
    currentLabel,
    windowHide,
    windowIsFocused,
    windowOuterPosition,
    windowSetIgnoreCursorEvents,
} from '../../lib/api/native'
import { platform } from '../../lib/api/os'
import { openWindow } from '../../lib/api/windows'

const toolbarLabel = currentLabel() ?? 'Toolbar'
const isWindows = platform === 'windows'
const isLinux = platform === 'linux'

const ELEMENT_ID_REGEX = /[^a-zA-Z0-9_-]/g

type PositionPayload = { x: number; y: number }

const shortcutModifierKey = platform === 'macos' ? 'command' : 'ctrl'
const letterShortcuts = 'BDEFGHIJKLMNOPQRSTUWYZ'.split('')

const getShortcutDisplay = (index: number): string | null => {
    if (index < 9) {
        return String(index + 1)
    }
    const letterIndex = index - 9
    if (letterIndex < 0 || letterIndex >= letterShortcuts.length) {
        return null
    }
    return letterShortcuts[letterIndex] ?? null
}

async function closeToolbar() {
    try {
        await windowHide(toolbarLabel)
    } catch (error) {
        console.warn('[Toolbar] Failed to hide toolbar', error)
    }
}

function Shortcut({ index, isActive }: { index: number; isActive: boolean }) {
    const shortcutDisplay = useMemo(() => getShortcutDisplay(index), [index])

    if (!shortcutDisplay) {
        return null
    }

    return (
        <Kbd
            keys={[shortcutModifierKey]}
            classNames={{
                base: cn('shadow-none bg-content3', isActive && 'bg-content2'),
                content: 'text-xs',
                abbr: 'text-xs',
            }}
        >
            {shortcutDisplay}
        </Kbd>
    )
}

export default function Toolbar() {
    const [engineResults, setEngineResults] = useState<ResolvedToolbarResult[]>([])

    const remotesQuery = useQuery({
        queryKey: ['remotes', 'list', 'all'],
        queryFn: async () => await rclone('/config/listremotes').then((r) => r?.remotes),
        refetchInterval: 60_000,
    })

    const remoteTypesQuery = useQuery({
        queryKey: ['remotes', 'types'],
        queryFn: async () => {
            const dump = await rclone('/config/dump')
            const types: Record<string, string> = {}
            if (dump && typeof dump === 'object') {
                for (const [name, config] of Object.entries(dump)) {
                    if (config && typeof config === 'object' && 'type' in config) {
                        types[name] = (config as { type: string }).type
                    }
                }
            }
            return types
        },
        refetchInterval: 60_000,
    })

    const { data: serveList } = useQuery({
        queryKey: ['serve', 'list'],
        queryFn: fetchServeList,
        refetchInterval: 5_000,
    })

    const { data: mountList } = useQuery({
        queryKey: ['mount', 'list'],
        queryFn: fetchMountList,
        refetchInterval: 5_000,
    })

    const { data: vfsList } = useQuery({
        queryKey: ['vfs', 'list'],
        queryFn: async () => {
            const response = await rclone('/vfs/list')
            return response?.vfses ?? []
        },
        refetchInterval: 5_000,
    })

    const remotes = useMemo(() => remotesQuery.data ?? [], [remotesQuery.data])
    const remoteTypes = useMemo(() => remoteTypesQuery.data ?? {}, [remoteTypesQuery.data])

    // Eager per-remote capability probes (operations/fsinfo), cached hard. Feeds the synchronous
    // engine so cleanup/purge can gate on the authoritative feature set. Unresolved/unreachable
    // remotes are simply absent from the map → those actions fall to their generic item.
    //
    // Built via `combine` (not a useMemo over the raw useQueries array) on purpose: react-query runs
    // the combined value through replaceEqualDeep, so `capabilitiesByRemote` keeps a STABLE reference
    // across renders until the capability data actually changes. A useMemo keyed on the useQueries
    // result recomputed every render (that array is new each time), so the engine effect below re-ran
    // and called setState on every render — an infinite update loop.
    const capabilitiesByRemote = useQueries({
        queries: remotes.map((remote) => fsInfoQueryOptions(remote)),
        combine: (results) => {
            const map: Record<string, RcloneFeatures> = {}
            remotes.forEach((remote, i) => {
                const features = results[i]?.data?.Features
                if (features) map[remote] = features
            })
            return map
        },
    })

    // Everything result generation may look at, in one value: the engine reads this and the
    // query, never a cache or a store, so the effect's inputs are exactly its dependencies.
    const currentHostId = usePersistedStore((state) => state.currentHostId)
    const snapshot = useMemo<ToolbarSnapshot>(
        () => ({
            hostIsLocal: currentHostId === 'local',
            mounts: mountList ?? [],
            serves: serveList ?? [],
            vfses: vfsList ?? [],
        }),
        [currentHostId, mountList, serveList, vfsList]
    )
    const [searchString, setSearchString] = useState('')
    const [searchStringDebounced] = useDebounce(searchString, 40)

    const [highlightedIndex, setHighlightedIndex] = useState(0)

    const isKeyboardNavigatingRef = useRef(false)
    const lastMousePositionRef = useRef<{ x: number; y: number } | null>(null)

    const activeAreaRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        console.log(`${snapshot.mounts.length} mounts`)
        console.log(`${snapshot.serves.length} serves`)
        console.log(`${snapshot.vfses.length} vfses`)

        const { results } = runToolbarEngine(
            searchStringDebounced,
            remotes,
            remoteTypes,
            capabilitiesByRemote,
            snapshot
        )
        startTransition(() => {
            setEngineResults(results)
        })
    }, [snapshot, searchStringDebounced, remotes, remoteTypes, capabilitiesByRemote])

    useEffect(() => {
        let blurTimeoutId: ReturnType<typeof setTimeout> | undefined

        const unlisten = onAppEvent('window.blur', async (event) => {
            if (event.label !== toolbarLabel) return
            if (isWindows) {
                blurTimeoutId = setTimeout(async () => {
                    try {
                        const isFocused = await windowIsFocused(toolbarLabel)
                        if (!isFocused) {
                            await closeToolbar()
                        }
                    } catch {
                        await closeToolbar()
                    }
                }, 100)
            } else {
                await closeToolbar()
            }
        })

        return () => {
            unlisten()
            if (blurTimeoutId) {
                clearTimeout(blurTimeoutId)
            }
        }
    }, [])

    useEffect(() => {
        return onAppEvent('window.focus', (event) => {
            if (event.label !== toolbarLabel || event.focused === false) return
            setTimeout(() => {
                inputRef.current?.focus()
            }, 50)
        })
    }, [])

    const handleExecute = useCallback(async (result: ResolvedToolbarResult) => {
        let keepOpen = false

        try {
            const action = result.resolve()
            await action.onPress(result.args, {
                openWindow,
                updateText: (text: string) => {
                    setSearchString(text)
                    keepOpen = true
                },
            })
        } catch (error) {
            console.error('[Toolbar] Failed to execute action', error)
        }

        if (!keepOpen) {
            await closeToolbar()
            setSearchString('')
        }
    }, [])

    const executeShortcutAtIndex = useCallback(
        async (targetIndex: number) => {
            const selected = engineResults[targetIndex]
            if (!selected) {
                return false
            }
            startTransition(() => {
                setHighlightedIndex(targetIndex)
            })
            await handleExecute(selected)
            return true
        },
        [engineResults, handleExecute]
    )

    const tryHandleIndexShortcut = useCallback(
        async (event: KeyboardEvent<HTMLInputElement>) => {
            const modifierPressed = platform === 'macos' ? event.metaKey : event.ctrlKey
            if (!modifierPressed || event.altKey || event.shiftKey) {
                return false
            }
            const shortcutNumber = Number.parseInt(event.key, 10)
            if (!Number.isNaN(shortcutNumber) && shortcutNumber > 0 && shortcutNumber <= 9) {
                const targetIndex = shortcutNumber - 1
                event.preventDefault()
                return executeShortcutAtIndex(targetIndex)
            }

            if (event.key.length === 1) {
                const key = event.key.toUpperCase()
                if (letterShortcuts.includes(key)) {
                    const letterIndex = letterShortcuts.indexOf(key)
                    const targetIndex = 9 + letterIndex
                    event.preventDefault()
                    return executeShortcutAtIndex(targetIndex)
                }
            }

            return false
        },
        [executeShortcutAtIndex]
    )

    const moveHighlightDown = useCallback(() => {
        if (engineResults.length === 0) {
            return
        }
        isKeyboardNavigatingRef.current = true
        setHighlightedIndex((index) => {
            const nextIndex = index + 1
            if (nextIndex >= engineResults.length) {
                return 0
            }
            return nextIndex
        })
    }, [engineResults.length])

    const moveHighlightUp = useCallback(() => {
        if (engineResults.length === 0) {
            return
        }
        isKeyboardNavigatingRef.current = true
        setHighlightedIndex((index) => {
            if (index <= 0) {
                return engineResults.length - 1
            }
            return index - 1
        })
    }, [engineResults.length])

    const handleMouseMove = useCallback((event: ReactMouseEvent) => {
        const lastPos = lastMousePositionRef.current
        if (lastPos && (lastPos.x !== event.clientX || lastPos.y !== event.clientY)) {
            isKeyboardNavigatingRef.current = false
        }
        lastMousePositionRef.current = { x: event.clientX, y: event.clientY }
    }, [])

    const handleItemMouseEnter = useCallback((index: number) => {
        if (isKeyboardNavigatingRef.current) {
            return
        }
        setHighlightedIndex(index)
    }, [])

    const selectHighlightedResult = useCallback(async () => {
        if (highlightedIndex < 0) {
            return
        }
        const selected = engineResults[highlightedIndex]
        if (!selected) {
            return
        }
        await handleExecute(selected)
    }, [highlightedIndex, engineResults, handleExecute])

    const handleKeyDown = useCallback(
        async (event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'ArrowDown') {
                event.preventDefault()
                moveHighlightDown()
                return
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault()
                moveHighlightUp()
                return
            }
            if (event.key === 'Enter') {
                event.preventDefault()
                await selectHighlightedResult()
                return
            }
            if (event.key === 'Escape') {
                event.preventDefault()
                await closeToolbar()
                return
            }

            await tryHandleIndexShortcut(event)
        },
        [moveHighlightDown, moveHighlightUp, selectHighlightedResult, tryHandleIndexShortcut]
    )

    useEffect(() => {
        if (engineResults.length === 0) {
            startTransition(() => {
                setHighlightedIndex(-1)
            })
            return
        }
        startTransition(() => {
            setHighlightedIndex((previous) => {
                if (previous < 0) return 0
                if (previous >= engineResults.length) return engineResults.length - 1
                return previous
            })
        })
    }, [engineResults])

    useEffect(() => {
        if (isWindows) {
            return
        }

        let ignoreState: boolean | null = null
        let windowPosition: PositionPayload = { x: 0, y: 0 }
        let unlistenDeviceMove: (() => void) | undefined
        let unlistenWindowMove: (() => void) | undefined

        const updateCursorIgnore = (value: boolean) => {
            windowSetIgnoreCursorEvents(value, toolbarLabel).catch((error) =>
                console.warn('failed to update cursor events', error)
            )
        }

        const computeHitbox = () => {
            const element = activeAreaRef.current
            if (!element) {
                return null
            }
            const rect = element.getBoundingClientRect()
            const dpr = window.devicePixelRatio || 1

            return {
                left: windowPosition.x + rect.left * dpr,
                right: windowPosition.x + rect.right * dpr,
                top: windowPosition.y + rect.top * dpr,
                bottom: windowPosition.y + rect.bottom * dpr,
            }
        }

        const setup = async () => {
            await windowSetIgnoreCursorEvents(false, toolbarLabel)
            try {
                const position = await windowOuterPosition(toolbarLabel)
                if (position) windowPosition = { x: position.x, y: position.y }
            } catch (error) {
                console.warn('failed to read window position', error)
            }

            unlistenWindowMove = onAppEvent('window.moved', (event) => {
                if (event.label !== toolbarLabel) return
                windowPosition = { x: event.x ?? 0, y: event.y ?? 0 }
            })

            const handlePointerMove = (event: PointerEvent) => {
                const hitbox = computeHitbox()
                if (!hitbox) {
                    return
                }

                const dpr = window.devicePixelRatio || 1
                const pointerX = windowPosition.x + event.clientX * dpr
                const pointerY = windowPosition.y + event.clientY * dpr

                const inside =
                    pointerX >= hitbox.left &&
                    pointerX <= hitbox.right &&
                    pointerY >= hitbox.top &&
                    pointerY <= hitbox.bottom

                const shouldIgnore = !inside
                if (shouldIgnore !== ignoreState) {
                    updateCursorIgnore(shouldIgnore)
                    ignoreState = shouldIgnore
                }
            }

            window.addEventListener('pointermove', handlePointerMove)
            unlistenDeviceMove = () => {
                window.removeEventListener('pointermove', handlePointerMove)
            }
        }

        setup().catch((error) => console.warn('failed to initialise cursor ignore handling', error))

        return () => {
            if (unlistenDeviceMove) {
                unlistenDeviceMove()
            }
            if (unlistenWindowMove) {
                unlistenWindowMove()
            }
            updateCursorIgnore(false)
        }
    }, [])

    useEffect(() => {
        if (highlightedIndex < 0) return
        const result = engineResults[highlightedIndex]
        if (!result) return
        const element = document.getElementById(
            `tb-result-${result.id.replace(ELEMENT_ID_REGEX, '-')}`
        )
        element?.scrollIntoView({ block: 'nearest' })
    }, [highlightedIndex, engineResults])

    return (
        <div
            className={cn(
                'flex flex-col items-center justify-center w-full h-screen overflow-hidden',
                !isWindows && 'pb-[15vh]'
            )}
        >
            <div
                ref={activeAreaRef}
                className="flex border-divider border flex-col items-center justify-center bg-content2/[0.97] w-full max-w-[700px] max-h-full rounded-large"
            >
                <div
                    data-drag-region={true}
                    className="flex flex-row items-center w-full overflow-hidden h-14"
                >
                    <img
                        data-drag-region={true}
                        src="/icon.png"
                        alt="Icon"
                        className="object-contain ml-3 mr-2 size-6 invert dark:invert-0"
                    />
                    <input
                        ref={inputRef}
                        autoFocus
                        data-drag-region={!isLinux}
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck="false"
                        className="w-full h-full pb-0.5 text-2xl bg-transparent text-foreground focus:outline-none"
                        placeholder="Search commands, remotes, or paste a URL"
                        value={searchString}
                        onChange={(e) => setSearchString(e.target.value)}
                        onKeyDown={handleKeyDown}
                    />
                </div>

                <Divider />

                <ScrollShadow
                    className="h-[400px] min-h-0 w-full p-2"
                    onMouseMove={handleMouseMove}
                >
                    {engineResults.map((result, index) => {
                        const isActive = index === highlightedIndex
                        const elementId = `tb-result-${result.id.replace(ELEMENT_ID_REGEX, '-')}`
                        return (
                            <div key={result.id} className="flex flex-col">
                                <button
                                    id={elementId}
                                    type="button"
                                    onMouseEnter={() => handleItemMouseEnter(index)}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => handleExecute(result)}
                                    className={cn(
                                        'flex w-full flex-col gap-1 rounded-small px-2.5 py-2 text-left transition-colors ',
                                        isActive
                                            ? 'bg-primary/75 dark:bg-primary/50'
                                            : 'hover:bg-content2/60'
                                    )}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="font-medium text-medium">
                                            {result.label}
                                        </span>
                                        <Shortcut index={index} isActive={isActive} />
                                    </div>
                                    {result.description ? (
                                        <span
                                            className={cn(
                                                'text-small text-foreground-500',
                                                isActive && 'text-primary-800'
                                            )}
                                        >
                                            {result.description}
                                        </span>
                                    ) : null}
                                </button>
                                {index !== engineResults.length - 1 && (
                                    <div
                                        className={cn(
                                            'ml-2 border-b border-divider h-0.5 rounded-small transition-opacity',
                                            (isActive || highlightedIndex === index + 1) &&
                                                'opacity-0 duration-100'
                                        )}
                                    />
                                )}
                            </div>
                        )
                    })}
                </ScrollShadow>
            </div>
        </div>
    )
}
