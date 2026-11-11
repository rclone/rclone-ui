import {
    Button,
    cn,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Input,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'

import {
    AngleRightSmall as AngleRightSmallIcon,
    Check as CheckIcon,
    Folder as FolderIcon,
    Laptop as LaptopIcon,
    MoreHorizontalCircle as MoreHorizontalCircleIcon,
    Pen as PenIcon,
    Star as StarIcon,
} from '@zappicon/react'
import {
    type KeyboardEvent as ReactKeyboardEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react'
import {
    configNameOf,
    currentHost,
    formatRemote,
    joinLocalSegments,
    leadingSeparatorOf,
    localRootOf,
    localSegments,
} from '../../../lib/paths'
import { useRemotes } from '../../../lib/remotes'
import BackendIcon from '../BackendIcon'
import { TIP } from './PanelToolbar'
import type { RemoteString } from './types'
import { getPathSegments } from './utils'

const CRUMB = cn(
    'flex items-center h-7 min-w-0 max-w-48 px-2 gap-1.5 rounded-lg text-[13px] outline-hidden',
    'transition-colors duration-100 hover:bg-default-100 dark:hover:bg-default-100/70',
    'focus-visible:ring-2 focus-visible:ring-primary'
)

function Chevron() {
    return (
        <AngleRightSmallIcon
            aria-hidden={true}
            className="size-3.5 shrink-0 text-default-300 dark:text-default-400"
        />
    )
}

/**
 * Where the panel is: the place (a remote, this computer or the favorites) and then each folder
 * down to the one shown, as pills that open their folder. The pencil, which shows on hover, turns
 * the path into a field to type one. When the row is short, the folders between the place and the
 * one shown give way first.
 */
export default function PathBreadcrumb({
    remote,
    path,
    pathInput,
    onNavigate,
    onPathInputChange,
    isReadOnly = false,
    className,
}: {
    remote: RemoteString
    path: string
    pathInput: string
    onNavigate: (path: string) => void
    onPathInputChange: (value: string) => void
    isReadOnly?: boolean
    className?: string
}) {
    const [isInputMode, setIsInputMode] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    // A remote browsed with parameters (`gdrive,shared_with_me`) has the type of its config.
    const configName = remote ? configNameOf(remote) : null
    const remoteType = useRemotes().remotes.find((candidate) => candidate.name === configName)?.type

    // A remote location under its absolute root (`remote:/var/www`, which is the machine's `/`
    // on sftp) shows that root as its own crumb, `/`, before the segments. The remote's name
    // stands for the other root (`remote:`, the login folder). The two roots are different.
    const isRemote = remote !== 'UI_LOCAL_FS' && remote !== 'UI_FAVORITES'
    const absolute = isRemote && leadingSeparatorOf(currentHost()).test(path)
    const segments =
        remote === 'UI_LOCAL_FS'
            ? localSegments(path)
            : absolute
              ? ['/', ...getPathSegments(path)]
              : getPathSegments(path)

    // A local path is rebuilt with the host's separator. On a Windows host, the first segment
    // is the drive (`C:`) or the share (`\\nas\share`), which must start the path rather than
    // follow a slash.
    const handleSegmentClick = useCallback(
        (index: number) => {
            if (remote === 'UI_LOCAL_FS') {
                onNavigate(
                    index < 0
                        ? localRootOf(segments)
                        : joinLocalSegments(segments.slice(0, index + 1))
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
        (e: ReactKeyboardEvent<HTMLInputElement>) => {
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
            return <LaptopIcon className="size-4 shrink-0 text-default-500" />
        }
        if (remote === 'UI_FAVORITES') {
            return <StarIcon variant="filled" className="text-warning size-4 shrink-0" />
        }
        // A remote with no saved type (one written on the fly) shows a plain cloud.
        if (remote) {
            return (
                <BackendIcon
                    type={remoteType}
                    alt={remoteType}
                    className="size-4 shrink-0 rounded-[3px]"
                />
            )
        }
        return null
    }

    const remoteLabel =
        remote === 'UI_LOCAL_FS'
            ? t({
                  message: 'Local',
                  comment: 'The place in a path bar that stands for this computer.',
              })
            : remote === 'UI_FAVORITES'
              ? t`Favorites`
              : remote
    const atRoot = segments.length === 0

    return (
        <div className={cn('group/crumbs flex items-center min-w-0 gap-0.5', className)}>
            {isInputMode ? (
                <Input
                    ref={inputRef}
                    value={pathInput}
                    onChange={(e) => onPathInputChange(e.target.value)}
                    onKeyDown={handleInputKeyDown}
                    onBlur={() => setIsInputMode(false)}
                    placeholder={t`Enter path`}
                    aria-label={t`Path`}
                    size="sm"
                    variant="flat"
                    radius="md"
                    classNames={{
                        base: 'flex-1',
                        input: 'text-[13px] font-mono',
                        inputWrapper: 'h-8 min-h-8',
                    }}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                />
            ) : (
                <nav aria-label={t`Path`} className="flex items-center flex-1 min-w-0">
                    {isReadOnly ? (
                        <span className="flex items-center h-7 gap-1.5 px-2 font-semibold text-[13px] shrink-0">
                            {renderRemoteIcon()}
                            {remoteLabel}
                        </span>
                    ) : (
                        <button
                            type="button"
                            title={remoteLabel ?? undefined}
                            className={cn(
                                CRUMB,
                                'shrink-0',
                                atRoot ? 'font-semibold' : 'font-medium text-default-600'
                            )}
                            onClick={() => handleSegmentClick(-1)}
                            aria-current={atRoot ? 'location' : undefined}
                        >
                            {renderRemoteIcon()}
                            {/* In a narrow panel, the place's icon stands for it below its root. */}
                            <span className={cn('truncate max-w-40', !atRoot && '@max-lg:hidden')}>
                                {remoteLabel}
                            </span>
                        </button>
                    )}

                    {/* In a narrower panel, the folders between the place and the last two fold
                        into a menu, and in a narrow one, all but the folder shown. */}
                    {segments.length > 1 && (
                        <span
                            className={cn(
                                'items-center hidden shrink-0',
                                segments.length > 2 ? '@max-2xl:flex' : '@max-lg:flex'
                            )}
                        >
                            <Chevron />
                            <Dropdown placement="bottom-start">
                                <DropdownTrigger>
                                    <button
                                        type="button"
                                        aria-label={t`Folders above`}
                                        className={cn(CRUMB, 'text-default-500 px-1.5')}
                                    >
                                        <MoreHorizontalCircleIcon className="size-4" />
                                    </button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label={t`Folders above`}
                                    onAction={(key) => handleSegmentClick(Number(key))}
                                    items={segments
                                        .slice(0, -1)
                                        .map((segment, index) => ({ key: index, segment }))}
                                >
                                    {({ key, segment }) => (
                                        <DropdownItem
                                            key={key}
                                            textValue={segment}
                                            startContent={
                                                <FolderIcon
                                                    variant="filled"
                                                    className="size-4 text-sky-500"
                                                    style={{ marginLeft: Math.min(key, 6) * 8 }}
                                                />
                                            }
                                        >
                                            {segment}
                                        </DropdownItem>
                                    )}
                                </DropdownMenu>
                            </Dropdown>
                        </span>
                    )}

                    {segments.map((segment, index) => {
                        const isLast = index === segments.length - 1
                        return (
                            // The folders between the place and the one shown give way first, down
                            // to an ellipsis each. The folder shown keeps the most room.
                            <span
                                key={`${segment}-${index}`}
                                className={cn(
                                    'flex items-center',
                                    isLast
                                        ? 'min-w-0 shrink-[0.2]'
                                        : index === segments.length - 2
                                          ? 'min-w-9 @max-lg:hidden'
                                          : 'min-w-9 @max-2xl:hidden'
                                )}
                            >
                                <Chevron />
                                <button
                                    type="button"
                                    title={segment}
                                    className={cn(
                                        CRUMB,
                                        isLast
                                            ? 'font-semibold text-foreground'
                                            : 'text-default-500 hover:text-foreground'
                                    )}
                                    onClick={() => handleSegmentClick(index)}
                                    aria-current={isLast ? 'location' : undefined}
                                >
                                    <span className="truncate">{segment}</span>
                                </button>
                            </span>
                        )
                    })}
                </nav>
            )}

            {!isReadOnly && (
                <Tooltip
                    content={
                        isInputMode
                            ? t({
                                  message: 'Confirm',
                                  comment: 'Button: opens the path that was typed.',
                              })
                            : t`Edit path`
                    }
                    {...TIP}
                    closeDelay={0}
                >
                    <Button
                        isIconOnly={true}
                        size="sm"
                        variant="light"
                        radius="md"
                        aria-label={isInputMode ? t`Confirm path` : t`Edit path`}
                        onPress={isInputMode ? handleConfirmInput : toggleInputMode}
                        onMouseDown={isInputMode ? (e) => e.preventDefault() : undefined}
                        className="shrink-0 min-w-7 size-7"
                    >
                        {isInputMode ? (
                            <CheckIcon className="text-success size-4" />
                        ) : (
                            <PenIcon className="transition-opacity duration-150 opacity-0 size-3.5 text-default-500 group-hover/crumbs:opacity-100 group-focus-within/crumbs:opacity-100" />
                        )}
                    </Button>
                </Tooltip>
            )}
        </div>
    )
}
