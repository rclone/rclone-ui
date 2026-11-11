import { Button, cn, Input, ScrollShadow, Tooltip } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import {
    ExclamationTriangle as ExclamationTriangleIcon,
    FolderArrowDown as FolderArrowDownIcon,
    Folder as FolderIcon,
    InfoCircle as InfoCircleIcon,
    Sort as SortIcon,
    Xmark as XmarkIcon,
} from '@zappicon/react'
import { type ReactNode, useCallback, useState } from 'react'
import { pathProblem } from '../../lib/paths'
import { Panel } from './look/Panel'
import { TONE_GRADIENT, TONE_RGB, TONE_TEXT, type Tone } from './look/tones'
import type { AllowedKey } from './navigator/types'
import { pageLook } from './operation/look'
import { type Segment, segments, stressed } from './operation/summary'
import PathSelector from './PathSelector'
import { type PlaceKind, usePickerMemory } from './pickerMemory'

export const PICK_PLACEHOLDER = t`Enter a remote:path or local path, or click to choose a folder`
export const PATH_PLACEHOLDER = t`Enter a remote:path or local path`

export interface PathOptions {
    label: string
    placeholder: string
    description?: string
    showPicker: boolean
    clearable: boolean
    allowedKeys?: AllowedKey[]
    showFiles?: boolean
    labelPlacement?: 'inside' | 'outside'
    /**
     * Returns what is wrong with the typed path (defaults to pathProblem). A mount point can be a
     * drive letter, which isn't a path.
     */
    problemOf?: (path: string) => string | undefined
    /**
     * The kind of field, a source or a destination. While the field is empty, its picker opens
     * where the last pick for that kind was made (pickerMemory.ts). Other fields have none.
     */
    remember?: PlaceKind
}

const SOURCE: PathOptions = {
    label: t`Source`,
    showPicker: true,
    placeholder: PICK_PLACEHOLDER,
    clearable: true,
    showFiles: true,
    remember: 'source',
}

const DESTINATION: PathOptions = {
    label: t`Destination`,
    showPicker: true,
    placeholder: PATH_PLACEHOLDER,
    clearable: true,
    showFiles: false,
    remember: 'destination',
}

// The route panel. An operation's places sit in one panel, as a route: the source on top, the
// destination under it, joined by a line on the left in the page's tone. Pages with one place
// (Delete, Purge, Serve) use the same panel with a single stop.

/** Where a row sits on the route: its start, its end, a single place, or off the route. */
export type Stop = 'from' | 'to' | 'single' | 'none'

/** The line under a route: where the files land, a note, or a warning. */
export interface RouteNote {
    kind: 'lands' | 'info' | 'warning' | 'danger'
    text: ReactNode
}

const NOTE_ICON = {
    lands: FolderArrowDownIcon,
    info: InfoCircleIcon,
    warning: ExclamationTriangleIcon,
    danger: ExclamationTriangleIcon,
} as const

// Where a stop's dot sits: the middle of a 64 px field, or of a compact 36 px line.
const DOT_Y = { field: 'top-8', compact: 'top-[18px]' } as const
// The line above a destination's dot, which joins it to the line before it.
const TO_LINE = { field: 'h-8', compact: 'h-[18px]' } as const

/** The rail on the left of a row: the stop's dot, and the line that joins it to the next. */
function Rail({
    stop,
    tone,
    filled,
    size = 'field',
}: {
    stop: Stop
    tone: Tone
    filled?: boolean
    size?: keyof typeof DOT_Y
}) {
    const line = { background: `rgb(${TONE_RGB[tone]} / 0.35)` }
    return (
        <div aria-hidden={true} className="relative self-stretch w-9 shrink-0">
            {stop === 'from' && (
                <div
                    className={cn('absolute bottom-0 w-0.5 left-1/2 -translate-x-1/2', DOT_Y[size])}
                    style={line}
                />
            )}
            {stop === 'to' && (
                <div
                    className={cn('absolute top-0 w-0.5 left-1/2 -translate-x-1/2', TO_LINE[size])}
                    style={line}
                />
            )}
            {stop !== 'none' && (
                <span
                    className={cn(
                        'absolute -translate-x-1/2 -translate-y-1/2 rounded-full left-1/2 size-3',
                        DOT_Y[size],
                        stop === 'from' && !filled
                            ? 'border-[2.5px] bg-content1'
                            : `bg-linear-to-b ${TONE_GRADIENT[tone]}`
                    )}
                    style={
                        stop === 'from' && !filled
                            ? { borderColor: `rgb(${TONE_RGB[tone]})` }
                            : { boxShadow: `0 0 0 4px rgb(${TONE_RGB[tone]} / 0.18)` }
                    }
                />
            )}
        </div>
    )
}

/**
 * A row of a route panel: its place on the rail, then its field. The field is a bare PathField
 * or MultiPathField, or any field 64 px high (a URL, a filename). A compact row is a line of text
 * 36 px high, for a route that is only read (a transfer's report).
 */
export function RouteRow({
    stop,
    tone,
    filled,
    compact,
    children,
}: {
    stop: Stop
    tone: Tone
    /** Draws the start's dot filled, for a route that goes both ways (Bisync). */
    filled?: boolean
    compact?: boolean
    children: ReactNode
}) {
    return (
        <div className="flex items-start">
            <Rail stop={stop} tone={tone} filled={filled} size={compact ? 'compact' : 'field'} />
            <div className="flex-1 min-w-0">{children}</div>
        </div>
    )
}

/**
 * The panel that holds an operation's places, with the note under them. Every gap in it is 12 px:
 * around the fields, between a field and the line under it, and above the note.
 */
export function RoutePanel({
    tone,
    note,
    children,
    className,
}: {
    tone: Tone
    note?: RouteNote
    children: ReactNode
    className?: string
}) {
    const NoteIcon = note ? NOTE_ICON[note.kind] : undefined
    return (
        <Panel className={cn('p-3', className)}>
            {children}
            {note && NoteIcon && (
                <div
                    className={cn(
                        'flex items-start gap-0 py-2.5 pr-3 mt-3 -mx-3 -mb-3 border-t rounded-b-2xl border-divider text-small',
                        note.kind === 'danger' && 'bg-danger-50/60 dark:bg-danger-50/30',
                        note.kind === 'warning' && 'bg-warning-50/60 dark:bg-warning-50/20'
                    )}
                >
                    {/* As wide as the panel's padding and the rail, so the icon sits under the
                        dots. */}
                    <span className="flex justify-center w-[60px] pt-px shrink-0">
                        <NoteIcon
                            className={cn(
                                'size-4',
                                note.kind === 'lands' && TONE_TEXT[tone],
                                note.kind === 'info' && 'text-default-400',
                                note.kind === 'warning' && 'text-warning',
                                note.kind === 'danger' && 'text-danger'
                            )}
                        />
                    </span>
                    <p
                        className={cn(
                            'flex-1 min-w-0 leading-snug break-words text-pretty',
                            note.kind === 'danger'
                                ? 'text-danger-700 dark:text-danger-500'
                                : 'text-default-600'
                        )}
                    >
                        {note.text}
                    </p>
                </div>
            )}
        </Panel>
    )
}

/**
 * The line between the source and the destination, with the button that swaps the paths. Without
 * `onSwap`, only the hairline is drawn. `disabledReason` disables the button and replaces its
 * tooltip. `buttons={false}` is for rows with no buttons on the right (a transfer's report). A
 * compact link sits between compact rows.
 */
export function RouteLink({
    tone,
    onSwap,
    isEmpty,
    disabledReason,
    buttons = true,
    compact,
}: {
    tone: Tone
    onSwap?: () => void
    isEmpty?: boolean
    disabledReason?: string
    buttons?: boolean
    compact?: boolean
}) {
    return (
        <div className={cn('flex items-center', compact ? 'h-2' : 'h-6')}>
            <div aria-hidden={true} className="relative self-stretch w-9 shrink-0">
                <div
                    className="absolute inset-y-0 w-0.5 left-1/2 -translate-x-1/2"
                    style={{ background: `rgb(${TONE_RGB[tone]} / 0.35)` }}
                />
            </div>
            {/* The hairline runs from where the fields' text starts (their 12 px padding) to
                4 px inside the fields' right edge. */}
            <div className={cn('flex-1 h-px ml-3 bg-divider', buttons ? 'mr-2' : 'mr-3')} />
            {/* As wide as the folder buttons, so the swap button sits between them. The 28 px
                button reaches 2 px past the row on each side, and stays 6 px from the folder
                buttons. */}
            {buttons && (
                <div className="relative z-10 flex justify-center w-12 shrink-0">
                    {onSwap && (
                        <Tooltip content={disabledReason ?? t`Swap paths`} className="max-w-48">
                            <div>
                                <Button
                                    onPress={onSwap}
                                    type="button"
                                    isIconOnly={true}
                                    radius="full"
                                    aria-label={t`Swap paths`}
                                    isDisabled={isEmpty || !!disabledReason}
                                    data-focus-visible="false"
                                    className="size-7 min-w-7 bg-content1 text-default-600 shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_1px_3px_rgb(0_0_0/0.1)] dark:bg-default-100 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1)] data-[hover=true]:text-foreground"
                                >
                                    <SortIcon className="size-3.5" />
                                </Button>
                            </div>
                        </Tooltip>
                    )}
                </div>
            )}
        </div>
    )
}

function noteOf(description: string | undefined, kind: RouteNote['kind']): RouteNote | undefined {
    return description ? { kind, text: description } : undefined
}

export function PathFinder({
    sourcePath = '',
    setSourcePath,
    destPath = '',
    setDestPath,
    switchable = true,
    bothWays = false,
    sourceOptions = SOURCE,
    destOptions = DESTINATION,
    note,
}: {
    sourcePath?: string
    setSourcePath: (path: string | undefined) => void
    destPath?: string
    setDestPath: (path: string | undefined) => void
    switchable?: boolean
    /** The route goes both ways (Bisync): both stops are drawn alike. */
    bothWays?: boolean
    sourceOptions?: PathOptions
    destOptions?: PathOptions
    /** The line under the route. Defaults to the destination's description, as a note. */
    note?: RouteNote
}) {
    const { tone } = pageLook()
    const handleSwap = useCallback(() => {
        const temp = sourcePath
        setSourcePath(destPath || undefined)
        setDestPath(temp || undefined)
    }, [sourcePath, destPath, setSourcePath, setDestPath])

    const { description: destDescription, ...dest } = destOptions
    return (
        <RoutePanel tone={tone} note={note ?? noteOf(destDescription, 'info')}>
            <RouteRow stop="from" tone={tone} filled={bothWays}>
                <PathField
                    path={sourcePath}
                    setPath={setSourcePath}
                    {...sourceOptions}
                    bare={true}
                />
            </RouteRow>
            <RouteLink
                tone={tone}
                onSwap={switchable ? handleSwap : undefined}
                isEmpty={!sourcePath && !destPath}
            />
            <RouteRow stop="to" tone={tone}>
                <PathField
                    path={destPath}
                    setPath={setDestPath}
                    {...dest}
                    showFiles={false}
                    bare={true}
                />
            </RouteRow>
        </RoutePanel>
    )
}

/** Like PathFinder, with several sources. The paths can be swapped while there is one source. */
export function MultiPathFinder({
    sourcePaths = [],
    setSourcePaths,
    destPath = '',
    setDestPath,
    switchable = true,
    sourceOptions = SOURCE,
    destOptions = DESTINATION,
    note,
}: {
    sourcePaths?: string[]
    setSourcePaths: (paths: string[] | undefined) => void
    destPath?: string
    setDestPath: (path: string | undefined) => void
    switchable?: boolean
    sourceOptions?: PathOptions
    destOptions?: PathOptions
    /** The line under the route. Defaults to the destination's description, as a note. */
    note?: RouteNote
}) {
    const { tone } = pageLook()
    const handleSwap = useCallback(() => {
        if (sourcePaths.length > 1) {
            return
        }
        const temp = sourcePaths[0]
        setSourcePaths(destPath ? [destPath] : undefined)
        setDestPath(temp || undefined)
    }, [sourcePaths, destPath, setSourcePaths, setDestPath])

    const { description: destDescription, ...dest } = destOptions
    return (
        <RoutePanel tone={tone} note={note ?? noteOf(destDescription, 'info')}>
            <RouteRow stop="from" tone={tone}>
                <MultiPathField
                    paths={sourcePaths}
                    setPaths={setSourcePaths}
                    {...sourceOptions}
                    bare={true}
                />
            </RouteRow>
            <RouteLink
                tone={tone}
                onSwap={switchable ? handleSwap : undefined}
                isEmpty={!sourcePaths[0] && !destPath}
                disabledReason={
                    sourcePaths.length > 1
                        ? t`Cannot swap when multiple sources are selected`
                        : undefined
                }
            />
            <RouteRow stop="to" tone={tone}>
                <PathField
                    path={destPath}
                    setPath={setDestPath}
                    {...dest}
                    showFiles={false}
                    bare={true}
                />
            </RouteRow>
        </RoutePanel>
    )
}

/** The classes of a field in a route panel's row, which has no box of its own. */
export function bareField(invalid = false) {
    return {
        inputWrapper: cn(
            'h-16 px-3 shadow-none rounded-[10px] transition-colors duration-150',
            invalid
                ? 'bg-danger-50/70 data-[hover=true]:bg-danger-50 group-data-[focus=true]:bg-danger-50/70 dark:bg-danger-50/30 dark:data-[hover=true]:bg-danger-50/40 dark:group-data-[focus=true]:bg-danger-50/30'
                : 'bg-transparent data-[hover=true]:bg-default-100/70 group-data-[focus=true]:bg-default-100/70'
        ),
        label: 'font-medium text-default-500',
        helperWrapper: 'px-3 pb-1.5',
    }
}

function PickButton({
    bare,
    onPress,
    tall,
}: {
    bare?: boolean
    onPress: () => void
    tall?: boolean
}) {
    const browse = t({ message: 'Browse', comment: 'Button: opens the picker of a path field.' })
    if (bare) {
        return (
            <Tooltip content={browse} placement="top" delay={500} closeDelay={0}>
                <Button
                    onPress={onPress}
                    type="button"
                    isIconOnly={true}
                    variant="flat"
                    aria-label={browse}
                    className="mt-2 size-12 min-w-12 rounded-[10px] shrink-0 text-default-600 data-[hover=true]:text-foreground"
                    data-focus-visible="false"
                >
                    <FolderIcon className="size-[22px]" />
                </Button>
            </Tooltip>
        )
    }
    return (
        <Button
            onPress={onPress}
            type="button"
            isIconOnly={true}
            size="lg"
            aria-label={browse}
            className={cn('w-20', tall ? 'h-18' : 'h-16')}
            data-focus-visible="false"
        >
            <FolderIcon className="size-7" />
        </Button>
    )
}

export function PathField({
    path,
    setPath,
    label,
    placeholder = PICK_PLACEHOLDER,
    description,
    clearable = true,
    showPicker = true,
    allowedKeys,
    showFiles = true,
    labelPlacement,
    problemOf = pathProblem,
    remember,
    bare = false,
}: {
    path: string
    setPath: (path: string) => void
    label: string
    placeholder?: string
    description?: string
    clearable?: boolean
    showPicker?: boolean
    allowedKeys?: AllowedKey[]
    showFiles?: boolean
    labelPlacement?: 'inside' | 'outside'
    problemOf?: (path: string) => string | undefined
    remember?: PlaceKind
    /** Draws the field without a box of its own, for a row of a route panel. */
    bare?: boolean
}) {
    const [isOpen, setIsOpen] = useState<boolean>(false)
    const problem = path ? problemOf(path) : undefined
    const memory = usePickerMemory(remember, allowedKeys)

    return (
        <div className={cn('flex', bare ? 'gap-1 pr-0' : 'gap-2')}>
            <div className="flex-1 min-w-0">
                <Input
                    size="lg"
                    label={label}
                    labelPlacement={labelPlacement}
                    value={path || ''}
                    onValueChange={(e) => {
                        setPath(e)
                    }}
                    placeholder={placeholder}
                    isClearable={clearable}
                    description={description}
                    isInvalid={!!problem}
                    errorMessage={problem}
                    classNames={bare ? bareField(!!problem) : undefined}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                    onClear={() => {
                        setPath('')
                    }}
                />
            </div>
            {showPicker && <PickButton bare={bare} onPress={() => setIsOpen(true)} />}

            <PathSelector
                onClose={() => {
                    setIsOpen(false)
                }}
                onSelect={(items, shown) => {
                    setIsOpen(false)
                    const item = items[0]
                    if (!item) {
                        return
                    }
                    memory.remember(items, shown)
                    // Use the path as picked. rclone decides whether it is a folder when it is
                    // used.
                    setPath(item.path)
                }}
                isOpen={isOpen}
                // A field with a path opens the picker there, and an empty one where the last
                // pick for its kind was made.
                initialPaths={path ? [path] : memory.start ? [memory.start] : []}
                allowedKeys={allowedKeys}
                mode={showFiles ? 'both' : 'folders'}
                allowMultiple={false}
            />
        </div>
    )
}

/** With the label outside, it stays above the "X and N more" box too. */
function LabelledOutside({
    label,
    placement,
    children,
}: {
    label: string
    placement?: 'inside' | 'outside'
    children: ReactNode
}) {
    if (placement !== 'outside') return children
    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-small text-foreground-600">{label}</span>
            {children}
        </div>
    )
}

/**
 * What a field with several paths shows: "X and N more". The first path is marked, so that the
 * field can show the rest of the sentence dimmed.
 */
function severalWords(paths: readonly string[]): Segment[] {
    const first = stressed(paths[0])
    return segments(
        plural(paths.length - 1, {
            one: `${first} and # more`,
            other: `${first} and # more`,
        })
    )
}

/**
 * A field for one or more paths. A typed path is the only one. The picker adds paths, and with
 * several the field shows "X and N more", which lists each one with a remove button.
 */
export function MultiPathField({
    paths,
    setPaths,
    label,
    placeholder = PICK_PLACEHOLDER,
    description,
    showPicker = true,
    clearable = true,
    allowedKeys,
    showFiles = true,
    labelPlacement,
    remember,
    bare = false,
}: {
    paths: string[]
    setPaths: (paths: string[] | undefined) => void
    label: string
    placeholder?: string
    description?: string
    showPicker?: boolean
    clearable?: boolean
    allowedKeys?: AllowedKey[]
    showFiles?: boolean
    labelPlacement?: 'inside' | 'outside'
    remember?: PlaceKind
    /** Draws the field without a box of its own, for a row of a route panel. */
    bare?: boolean
}) {
    const [isOpen, setIsOpen] = useState<boolean>(false)
    const memory = usePickerMemory(remember, allowedKeys)

    const isMultipleSelected = paths.length > 1
    // Several paths can only come from the picker, which never returns a path rclone refuses.
    // A typed path is always the first and only one.
    const firstProblem = paths[0] ? pathProblem(paths[0]) : undefined

    return (
        <div className={cn('flex', bare ? 'gap-1' : 'gap-2')}>
            <div className="flex-1 min-w-0">
                {isMultipleSelected ? (
                    <LabelledOutside label={label} placement={labelPlacement}>
                        <Tooltip
                            content={
                                <ScrollShadow className="max-w-[500px] max-h-[300px] overflow-y-auto">
                                    {paths.map((path, pathIndex) => (
                                        <div
                                            className="relative flex flex-row items-center gap-2 line-clamp-1 group/pathItem"
                                            key={path}
                                        >
                                            <p className="w-4 text-right transition-opacity duration-100 opacity-100 group-hover/pathItem:opacity-0 tabular-nums">
                                                {pathIndex + 1}.{' '}
                                            </p>{' '}
                                            <Button
                                                size="sm"
                                                color="danger"
                                                aria-label={t`Remove ${path}`}
                                                className="absolute top-0 left-0 items-center justify-center min-w-0 transition-opacity duration-100 rounded-full opacity-0 -p-2 group-hover/pathItem:opacity-100 size-5"
                                                onPress={() =>
                                                    setPaths(paths.filter((p) => p !== path))
                                                }
                                            >
                                                <XmarkIcon className="size-4" />
                                            </Button>{' '}
                                            {path}
                                        </div>
                                    ))}
                                </ScrollShadow>
                            }
                            placement="bottom-start"
                        >
                            {bare ? (
                                <div className="flex items-center h-16 gap-2 px-3 rounded-[10px] transition-colors duration-150 hover:bg-default-100/70">
                                    <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                                        <span className="font-medium text-small text-default-500">
                                            {label}
                                        </span>
                                        <p className="truncate text-medium">
                                            {severalWords(paths).map((part) =>
                                                part.strong ? (
                                                    part.text
                                                ) : (
                                                    <span
                                                        key={part.text}
                                                        className="text-default-500"
                                                    >
                                                        {part.text}
                                                    </span>
                                                )
                                            )}
                                        </p>
                                    </div>
                                    <Button
                                        onPress={() => {
                                            setPaths([])
                                        }}
                                        isIconOnly={true}
                                        size="sm"
                                        variant="light"
                                        radius="full"
                                        aria-label={t`Clear the paths`}
                                    >
                                        <XmarkIcon className="size-4" />
                                    </Button>
                                </div>
                            ) : (
                                <div className="flex flex-row items-center h-16 gap-0.5 p-2.5 pl-4 justify-between overflow-y-auto bg-default-100 rounded-medium">
                                    <p className="text-large">
                                        {severalWords(paths)
                                            .map((part) => part.text)
                                            .join('')}
                                    </p>
                                    <Button
                                        onPress={() => {
                                            setPaths([])
                                        }}
                                        isIconOnly={true}
                                        size="sm"
                                        variant="light"
                                        radius="full"
                                        aria-label={t`Clear the paths`}
                                    >
                                        <XmarkIcon className="size-4" />
                                    </Button>
                                </div>
                            )}
                        </Tooltip>
                        {description && (
                            <p
                                className={cn(
                                    'pt-1 text-tiny text-foreground-400',
                                    bare ? 'px-3 pb-1.5' : 'px-1'
                                )}
                            >
                                {description}
                            </p>
                        )}
                    </LabelledOutside>
                ) : (
                    <Input
                        size="lg"
                        label={label}
                        labelPlacement={labelPlacement}
                        value={paths?.[0] || ''}
                        // An emptied field means no source, not a source of ''.
                        onValueChange={(e) => setPaths(e ? [e] : [])}
                        placeholder={placeholder}
                        description={description}
                        isInvalid={!!firstProblem}
                        errorMessage={firstProblem}
                        isClearable={clearable}
                        classNames={bare ? bareField(!!firstProblem) : undefined}
                        onClear={() => {
                            setPaths([])
                        }}
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck="false"
                    />
                )}
            </div>
            {showPicker && <PickButton bare={bare} tall={true} onPress={() => setIsOpen(true)} />}

            <PathSelector
                onClose={() => {
                    setIsOpen(false)
                }}
                onSelect={(items, shown) => {
                    setIsOpen(false)
                    memory.remember(items, shown)

                    const newPaths = new Set(paths)
                    for (const item of items) {
                        newPaths.add(item.path)
                    }
                    setPaths(Array.from(newPaths))
                }}
                isOpen={isOpen}
                // As in PathField: the field's first path, or where the last pick for its kind
                // was made.
                initialPaths={paths[0] ? paths : memory.start ? [memory.start] : []}
                allowedKeys={allowedKeys}
                mode={showFiles ? 'both' : 'folders'}
            />
        </div>
    )
}
