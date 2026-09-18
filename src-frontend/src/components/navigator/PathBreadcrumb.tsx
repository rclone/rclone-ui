import { Button, Input, Tooltip, cn } from '@heroui/react'

import { CheckIcon, ChevronRightIcon, LaptopIcon, PencilIcon, StarIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { joinLocalSegments, localRootOf } from '../../../lib/format'
import { useRemoteConfig } from '../../../lib/hooks'
import type { RemoteString } from './types'
import { getPathSegments } from './utils'
import { isNativeMac } from '../../../lib/api/os'
import { formatRemote } from '../../../lib/paths'
import { hostSeparator } from '../../../lib/rclone/client'

export default function PathBreadcrumb({
    remote,
    path,
    pathInput,
    onNavigate,
    onPathInputChange,
    isReadOnly = false,
}: {
    remote: RemoteString
    path: string
    pathInput: string
    onNavigate: (path: string) => void
    onPathInputChange: (value: string) => void
    isReadOnly?: boolean
}) {
    const [isInputMode, setIsInputMode] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    const remoteConfigQuery = useRemoteConfig(remote)

    const remoteType = remoteConfigQuery.data?.type

    // A remote location under its absolute root (`remote:/var/www`, the machine's `/` on sftp)
    // shows that root as a crumb of its own, `/`, ahead of the segments; the remote's name is
    // the other root (`remote:`, the login directory). Neither is the other.
    const isRemote = remote !== 'UI_LOCAL_FS' && remote !== 'UI_FAVORITES'
    const absolute = isRemote && /^[/\\]/.test(path)
    const segments = absolute ? ['/', ...getPathSegments(path)] : getPathSegments(path)

    // A local path is rebuilt with the selected host's separator (not the page server's): on
    // a Windows host the first segment is the drive (`C:`), which must lead the path, not
    // follow a slash.
    const handleSegmentClick = useCallback(
        (index: number) => {
            if (remote === 'UI_LOCAL_FS') {
                const sep = hostSeparator()
                onNavigate(
                    index < 0
                        ? localRootOf(segments, sep)
                        : joinLocalSegments(segments.slice(0, index + 1), sep)
                )
            } else if (isRemote && remote) {
                const dir =
                    index < 0
                        ? ''
                        : absolute
                          ? `/${segments.slice(1, index + 1).join('/')}`
                          : segments.slice(0, index + 1).join('/')
                onNavigate(formatRemote(remote, dir))
            }
        },
        [segments, absolute, isRemote, onNavigate, remote]
    )

    const handleInputKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
                const value = pathInput.trim()
                if (value) {
                    onNavigate(value)
                }
                setIsInputMode(false)
            } else if (e.key === 'Escape') {
                setIsInputMode(false)
            }
        },
        [pathInput, onNavigate]
    )

    const toggleInputMode = useCallback(() => {
        if (isReadOnly) return
        setIsInputMode((prev) => !prev)
    }, [isReadOnly])

    const handleConfirmInput = useCallback(() => {
        const value = pathInput.trim()
        if (value) {
            onNavigate(value)
        }
        setIsInputMode(false)
    }, [pathInput, onNavigate])

    useEffect(() => {
        if (isInputMode && inputRef.current) {
            inputRef.current.focus()
            inputRef.current.select()
        }
    }, [isInputMode])

    const renderRemoteIcon = () => {
        if (remote === 'UI_LOCAL_FS') {
            return <LaptopIcon className="size-4" />
        }
        if (remote === 'UI_FAVORITES') {
            return <StarIcon className="stroke-warning fill-warning size-4" />
        }
        if (remoteType) {
            return (
                <img
                    src={`/icons/backends/${remoteType}.png`}
                    className="object-contain size-4"
                    alt={remoteType}
                />
            )
        }
        return null
    }

    const remoteLabel =
        remote === 'UI_LOCAL_FS' ? 'Local' : remote === 'UI_FAVORITES' ? 'Favorites' : remote

    return (
        <div
            className={cn(
                'group flex items-center w-full h-12 px-3 gap-1 bg-default-100 border-b border-divider',
                isNativeMac && 'pt-5 h-16'
            )}
        >
            {isInputMode ? (
                <Input
                    ref={inputRef}
                    value={pathInput}
                    onChange={(e) => onPathInputChange(e.target.value)}
                    onKeyDown={handleInputKeyDown}
                    onBlur={() => setIsInputMode(false)}
                    placeholder="Enter path"
                    size="sm"
                    variant="flat"
                    radius="sm"
                    classNames={{
                        base: 'flex-1',
                        input: 'text-sm',
                        inputWrapper: 'h-8',
                    }}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                />
            ) : (
                <div className="flex items-center flex-1 gap-1 overflow-x-auto">
                    <Button
                        size="sm"
                        variant="light"
                        className="gap-1.5 min-w-fit px-2 shrink-0"
                        onPress={() => handleSegmentClick(-1)}
                        isDisabled={isReadOnly}
                    >
                        {renderRemoteIcon()}
                        <span className="text-sm font-medium">{remoteLabel}</span>
                    </Button>

                    {segments.map((segment, index) => (
                        <div
                            key={`${segment}-${index}`}
                            className="flex items-center gap-1 shrink-0"
                        >
                            <ChevronRightIcon className="text-default-400 size-4 shrink-0" />
                            <Button
                                size="sm"
                                variant="light"
                                className="px-2 min-w-fit"
                                onPress={() => handleSegmentClick(index)}
                                isDisabled={isReadOnly}
                            >
                                <span className="text-sm">{segment}</span>
                            </Button>
                        </div>
                    ))}
                </div>
            )}

            {!isReadOnly && (
                <Tooltip
                    content={isInputMode ? 'Confirm' : 'Edit path'}
                    size="sm"
                    color="foreground"
                >
                    <Button
                        isIconOnly={true}
                        size="sm"
                        variant="light"
                        onPress={isInputMode ? handleConfirmInput : toggleInputMode}
                        onMouseDown={isInputMode ? (e) => e.preventDefault() : undefined}
                        className="shrink-0"
                    >
                        {isInputMode ? (
                            <CheckIcon className="text-success size-4" />
                        ) : (
                            <PencilIcon className="transition-opacity duration-300 opacity-0 size-4 group-hover:opacity-100" />
                        )}
                    </Button>
                </Tooltip>
            )}
        </div>
    )
}
