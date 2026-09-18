import { Input, ScrollShadow, Tooltip } from '@heroui/react'
import { Button } from '@heroui/react'

import { ArrowDownUp, FolderOpen, XIcon } from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import PathSelector from './PathSelector'
import type { AllowedKey } from './navigator/types'
import { pathProblem } from '../../lib/paths'

export function PathFinder({
    sourcePath = '',
    setSourcePath,
    destPath = '',
    setDestPath,
    switchable = true,
    sourceOptions = {
        label: 'Source',
        showPicker: true,
        placeholder: 'Enter a remote:path or local path, or tap on the folder icon',
        clearable: true,
        showFiles: true,
        allowedKeys: ['LOCAL_FS', 'LOCAL_FS_EXTRA', 'REMOTES', 'FAVORITES'],
    },
    destOptions = {
        label: 'Destination',
        showPicker: true,
        placeholder: 'Enter a remote:path or local path or tap on the folder icon',
        clearable: true,
        showFiles: true,
        allowedKeys: ['LOCAL_FS', 'LOCAL_FS_EXTRA', 'REMOTES', 'FAVORITES'],
    },
}: {
    sourcePath?: string
    setSourcePath: (path: string | undefined) => void
    destPath?: string
    setDestPath: (path: string | undefined) => void
    switchable?: boolean
    sourceOptions?: {
        label: string
        placeholder: string
        showPicker: boolean
        clearable: boolean
        allowedKeys?: AllowedKey[]
        showFiles?: boolean
    }
    destOptions?: {
        label: string
        placeholder: string
        showPicker: boolean
        clearable: boolean
        allowedKeys?: AllowedKey[]
        showFiles?: boolean
    }
}) {
    const handleSwap = useCallback(() => {
        const temp = sourcePath
        // handles empty strings => undefined
        setSourcePath(destPath || undefined)
        setDestPath(temp || undefined)
    }, [sourcePath, destPath, setSourcePath, setDestPath])

    return (
        <div className="flex flex-col gap-8">
            <PathField
                path={sourcePath}
                setPath={setSourcePath}
                label={sourceOptions.label}
                placeholder={sourceOptions.placeholder}
                clearable={sourceOptions.clearable}
                showPicker={sourceOptions.showPicker}
                allowedKeys={sourceOptions.allowedKeys}
                showFiles={sourceOptions.showFiles}
            />

            {switchable && (
                <div className="flex justify-center">
                    <Button
                        onPress={handleSwap}
                        type="button"
                        isIconOnly={true}
                        size="lg"
                        isDisabled={!sourcePath && !destPath}
                        data-focus-visible="false"
                    >
                        <ArrowDownUp className="w-6 h-6" />
                    </Button>
                </div>
            )}

            <PathField
                path={destPath}
                setPath={setDestPath}
                label={destOptions.label}
                placeholder={destOptions.placeholder}
                clearable={destOptions.clearable}
                showPicker={destOptions.showPicker}
                allowedKeys={destOptions.allowedKeys}
                showFiles={false}
            />
        </div>
    )
}

export function MultiPathFinder({
    sourcePaths = [],
    setSourcePaths,
    destPath = '',
    setDestPath,
    switchable = true,
    sourceOptions = {
        label: 'Source',
        showPicker: true,
        placeholder: 'Enter a remote:path or local path, or tap on the folder icon',
        clearable: true,
    },
    destOptions = {
        label: 'Destination',
        showPicker: true,
        placeholder: 'Enter a remote:path or local path or tap on the folder icon',
        clearable: true,
    },
}: {
    sourcePaths?: string[]
    setSourcePaths: (paths: string[] | undefined) => void
    destPath?: string
    setDestPath: (path: string | undefined) => void
    switchable?: boolean
    sourceOptions?: {
        label: string
        placeholder: string
        showPicker: boolean
        clearable: boolean
    }
    destOptions?: {
        label: string
        placeholder: string
        showPicker: boolean
        clearable: boolean
    }
}) {
    const handleSwap = useCallback(() => {
        if (sourcePaths.length !== 1) {
            return
        }
        const temp = sourcePaths[0]
        setSourcePaths(destPath ? [destPath] : undefined)
        setDestPath(temp || undefined)
    }, [sourcePaths, destPath, setSourcePaths, setDestPath])

    const isSwapDisabled = useMemo(() => sourcePaths.length !== 1, [sourcePaths])

    const swapDisabledReason = useMemo(() => {
        if (sourcePaths.length > 1) {
            return 'Cannot swap when multiple sources are selected'
        }
        return 'Swap sources'
    }, [sourcePaths])

    return (
        <div className="flex flex-col gap-8">
            <MultiPathField
                paths={sourcePaths}
                setPaths={setSourcePaths}
                label={sourceOptions.label}
                placeholder={sourceOptions.placeholder}
                clearable={sourceOptions.clearable}
            />

            {switchable && (
                <div className="flex justify-center">
                    <Tooltip content={swapDisabledReason} className="max-w-48">
                        <div>
                            <Button
                                onPress={handleSwap}
                                type="button"
                                isIconOnly={true}
                                size="lg"
                                isDisabled={isSwapDisabled}
                                data-focus-visible="false"
                            >
                                <ArrowDownUp className="w-6 h-6" />
                            </Button>
                        </div>
                    </Tooltip>
                </div>
            )}

            <PathField
                path={destPath}
                setPath={setDestPath}
                label={destOptions.label}
                placeholder={destOptions.placeholder}
                clearable={destOptions.clearable}
                showFiles={false}
            />
        </div>
    )
}

export function PathField({
    path,
    setPath,
    label,
    placeholder = 'Enter a remote:path or local path, or tap on the folder icon',
    description,
    clearable = true,
    showPicker = true,
    allowedKeys,
    showFiles = true,
    labelPlacement,
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
    /** The operation pages keep the label inside the field; a form of labelled rows wants it out. */
    labelPlacement?: 'inside' | 'outside'
}) {
    const [isOpen, setIsOpen] = useState<boolean>(false)
    const problem = path ? pathProblem(path) : undefined

    return (
        <div className="flex gap-2">
            <div className="flex-1">
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
                    // What rclone would refuse, or read as something else than meant, said here.
                    isInvalid={!!problem}
                    errorMessage={problem}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                    onClear={() => {
                        setPath('')
                    }}
                />
            </div>
            {showPicker && (
                <Button
                    onPress={() => {
                        setIsOpen(true)
                    }}
                    type="button"
                    isIconOnly={true}
                    size="lg"
                    className="w-20 h-16"
                    data-focus-visible="false"
                >
                    <FolderOpen className="size-7" />
                </Button>
            )}

            <PathSelector
                onClose={() => {
                    setIsOpen(false)
                }}
                onSelect={(items) => {
                    console.log('[Copy] items', items)
                    setIsOpen(false)
                    const item = items[0]
                    if (!item) {
                        return
                    }
                    // As picked: whether it is a folder is rclone's to say when it is used.
                    setPath(item.path)
                }}
                isOpen={isOpen}
                initialPaths={path ? [path] : []}
                allowedKeys={allowedKeys}
                mode={showFiles ? 'both' : 'folders'}
                allowMultiple={false}
            />
        </div>
    )
}

/**
 * The several-paths box is a plain div, so an outside label has to be drawn for it; inside the
 * field (what every operation page asks for) HeroUI draws it and this passes straight through.
 */
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

export function MultiPathField({
    paths,
    setPaths,
    label,
    placeholder = 'Enter a remote:path or local path, or tap on the folder icon',
    showPicker = true,
    clearable = true,
    labelPlacement,
    allowedKeys,
    showFiles = true,
}: {
    paths: string[]
    setPaths: (paths: string[] | undefined) => void
    label: string
    placeholder?: string
    showPicker?: boolean
    clearable?: boolean
    allowedKeys?: AllowedKey[]
    showFiles?: boolean
    /** See PathField: outside also gives the several-paths box a label, which it otherwise has none. */
    labelPlacement?: 'inside' | 'outside'
}) {
    const [isOpen, setIsOpen] = useState<boolean>(false)

    const isMultipleSelected = paths.length > 1
    // Several paths come from the picker, which hands out nothing rclone refuses; a typed one
    // is the first and only.
    const firstProblem = paths[0] ? pathProblem(paths[0]) : undefined

    return (
        <div className="flex gap-2">
            <div className="flex-1">
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
                                                className="absolute top-0 left-0 items-center justify-center min-w-0 transition-opacity duration-100 rounded-full opacity-0 -p-2 group-hover/pathItem:opacity-100 size-5"
                                                onPress={() => {
                                                    setTimeout(() => {
                                                        setPaths(paths.filter((p) => p !== path))
                                                    }, 100)
                                                }}
                                            >
                                                <XIcon className="size-4" />
                                            </Button>{' '}
                                            {path}
                                        </div>
                                    ))}
                                </ScrollShadow>
                            }
                            placement="bottom-start"
                        >
                            <div className="flex flex-row items-center h-16 gap-0.5 p-2.5 pl-4 justify-between overflow-y-auto bg-default-100 rounded-medium">
                                <p className="text-large">{`${paths[0]} and ${paths.length - 1} more`}</p>
                                <Button
                                    onPress={() => {
                                        setPaths([])
                                    }}
                                    isIconOnly={true}
                                    size="sm"
                                    variant="light"
                                    radius="full"
                                >
                                    <XIcon className="size-4" />
                                </Button>
                            </div>
                        </Tooltip>
                    </LabelledOutside>
                ) : (
                    <Input
                        size="lg"
                        label={label}
                        labelPlacement={labelPlacement}
                        value={paths?.[0] || ''}
                        onValueChange={(e) => setPaths([e])}
                        placeholder={placeholder}
                        isInvalid={!!firstProblem}
                        errorMessage={firstProblem}
                        isClearable={clearable}
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
            {showPicker && (
                <Button
                    onPress={() => {
                        setIsOpen(true)
                    }}
                    isIconOnly={true}
                    size="lg"
                    className="w-20 h-18"
                    data-focus-visible="false"
                >
                    <FolderOpen className="size-7" />
                </Button>
            )}

            <PathSelector
                onClose={() => {
                    setIsOpen(false)
                }}
                onSelect={(items) => {
                    console.log('[Copy] items', items)
                    setIsOpen(false)

                    const newPaths = new Set(paths)
                    for (const item of items) {
                        newPaths.add(item.path)
                    }
                    setPaths(Array.from(newPaths))
                }}
                isOpen={isOpen}
                initialPaths={paths}
                allowedKeys={allowedKeys}
                mode={showFiles ? 'both' : 'folders'}
            />
        </div>
    )
}
