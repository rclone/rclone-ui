import {
    Accordion,
    AccordionItem,
    Avatar,
    Button,
    ButtonGroup,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Tooltip,
} from '@heroui/react'
import { useMutation } from '@tanstack/react-query'

import { AnimatePresence, motion } from 'framer-motion'
import {
    AlertOctagonIcon,
    ClockIcon,
    FilterIcon,
    FoldersIcon,
    HardDriveIcon,
    PlayIcon,
    TagsIcon,
    WavesLadderIcon,
    WrenchIcon,
} from 'lucide-react'
import { startTransition, useEffect, useMemo, useState } from 'react'
import { message } from '../../lib/api/dialog'
import { pathsProblem } from '../../lib/paths'
import { platform } from '../../lib/api/os'
import { openPath } from '../../lib/api/shell'
import { closeSelf } from '../../lib/api/windows'
import { reportError } from '../../lib/errors'
import { getOptionsSubtitle } from '../../lib/flags'
import { useFlags } from '../../lib/hooks'
import { applyTemplatePaths, pathsFromArgs } from '../../lib/rclone/templatePaths'
import { startMount } from '../../lib/rclone/api'
import { RCLONE_CONFIG_DEFAULTS } from '../../lib/rclone/constants'
import { metadataOptionsProblem } from '../../lib/rclone/metadataMapper'
import { dialogGetMountPlugin } from '../../lib/rclone/mount'
import { needsMountPlugin } from '../../lib/rclone/mount'
import { usePersistedStore } from '../../store/persisted'
import type { FlagValue } from '../../types/rclone'
import CommandInfoButton from '../components/CommandInfoButton'
import CommandsDropdown from '../components/CommandsDropdown'
import OperationWindowContent from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import OptionsSection from '../components/OptionsSection'
import { PathFinder } from '../components/PathFinder'
import TemplatesDropdown from '../components/TemplatesDropdown'
import { useOperationPreset } from '../components/operation/useOperationPreset'

export default function Mount() {
    const { preset, onStarted } = useOperationPreset('mount')
    const { globalFlags, filterFlags, configFlags, mountFlags, vfsFlags, metadataFlags } =
        useFlags()

    const [source, setSource] = useState<string | undefined>(preset?.args.source)
    const [dest, setDest] = useState<string | undefined>(preset?.args.destination)

    const [jsonError, setJsonError] = useState<
        'mount' | 'vfs' | 'filter' | 'config' | 'metadata' | null
    >(null)

    const [mountOptionsLocked, setMountOptionsLocked] = useState(false)
    const [mountOptions, setMountOptions] = useState<Record<string, FlagValue>>({})
    const [mountOptionsJsonString, setMountOptionsJsonString] = useState<string>('{}')

    const [vfsOptionsLocked, setVfsOptionsLocked] = useState(false)
    const [vfsOptions, setVfsOptions] = useState<Record<string, FlagValue>>({})
    const [vfsOptionsJsonString, setVfsOptionsJsonString] = useState<string>('{}')

    const [filterOptionsLocked, setFilterOptionsLocked] = useState(false)
    const [filterOptions, setFilterOptions] = useState<Record<string, FlagValue>>({})
    const [filterOptionsJsonString, setFilterOptionsJsonString] = useState<string>('{}')

    const [configOptionsLocked, setConfigOptionsLocked] = useState(false)
    const [configOptions, setConfigOptions] = useState<Record<string, FlagValue>>({})
    const [configOptionsJsonString, setConfigOptionsJsonString] = useState<string>('{}')

    const [metadataOptionsLocked, setMetadataOptionsLocked] = useState(false)
    const [metadataOptions, setMetadataOptions] = useState<Record<string, FlagValue>>({})
    const [metadataOptionsJsonString, setMetadataOptionsJsonString] = useState<string>('{}')

    // Seeds the option strings once: the preset's groups where it carries them, the defaults
    // otherwise (the parse effect derives the values).
    useEffect(() => {
        const given = preset?.args.options
        const json = (options: Record<string, FlagValue> | undefined, fallback = {}) =>
            JSON.stringify(options ?? fallback, null, 2)
        startTransition(() => {
            setMountOptionsJsonString(json(given?.mount))
            setVfsOptionsJsonString(json(given?.vfs))
            setFilterOptionsJsonString(json(given?.filter))
            setConfigOptionsJsonString(json(given?.config, RCLONE_CONFIG_DEFAULTS.config))
            setMetadataOptionsJsonString(json(given?.metadata))
        })
    }, [preset])

    useEffect(() => {
        let step: 'mount' | 'vfs' | 'filter' | 'config' | 'metadata' = 'mount'
        try {
            const parsedMount = JSON.parse(mountOptionsJsonString) as Record<string, FlagValue>

            step = 'vfs'
            const parsedVfs = JSON.parse(vfsOptionsJsonString) as Record<string, FlagValue>

            step = 'filter'
            const parsedFilter = JSON.parse(filterOptionsJsonString) as Record<string, FlagValue>

            step = 'config'
            const parsedConfig = JSON.parse(configOptionsJsonString) as Record<string, FlagValue>

            step = 'metadata'
            const parsedMetadata = JSON.parse(metadataOptionsJsonString) as Record<
                string,
                FlagValue
            >

            startTransition(() => {
                setMountOptions(parsedMount)
                setVfsOptions(parsedVfs)
                setFilterOptions(parsedFilter)
                setConfigOptions(parsedConfig)
                setMetadataOptions(parsedMetadata)
                setJsonError(null)
            })
        } catch (error) {
            setJsonError(step)
            console.error(`[Mount] Error parsing ${step} options:`, error)
        }
    }, [
        mountOptionsJsonString,
        vfsOptionsJsonString,
        filterOptionsJsonString,
        configOptionsJsonString,
        metadataOptionsJsonString,
    ])

    const startMountMutation = useMutation({
        mutationFn: async ({ dest, source }: { dest?: string; source?: string }) => {
            if (!dest || !source) throw new Error('Destination and source are required')
            const problem = pathsProblem([source, dest])
            if (problem) throw new Error(problem)

            const resolvedMountPoint = await startMount({
                source: source,
                destination: dest,
                options: {
                    mount: mountOptions,
                    vfs: vfsOptions,
                    filter: filterOptions,
                    config: configOptions,
                    metadata: metadataOptions,
                },
            })

            return resolvedMountPoint || dest
        },
        onSuccess: async () => {
            onStarted(
                () => ({
                    ...mountOptions,
                    ...vfsOptions,
                    ...filterOptions,
                    ...configOptions,
                    ...metadataOptions,
                }),
                () => pathsFromArgs({ source, destination: dest })
            )
            if (usePersistedStore.getState().acknowledgements.includes('firstMount')) {
                return
            }

            await message(
                'You can open the Toolbar and search for "Mount" to see active mounts and unmount them.',
                {
                    title: 'Mount Started',
                    kind: 'info',
                    buttons: {
                        ok: 'Good to know',
                    },
                }
            )

            usePersistedStore.setState((prev) => {
                if (prev.acknowledgements.includes('firstMount')) {
                    return prev
                }

                return {
                    acknowledgements: [...prev.acknowledgements, 'firstMount'],
                }
            })
        },
        onError: async (error) => {
            const needsPlugin = await needsMountPlugin()
            if (needsPlugin) {
                console.log('[Mount] Mount plugin not installed')
                await dialogGetMountPlugin()
                return
            }
            console.log('[Mount] Mount plugin installed, but failed to start mount')
            console.error('Failed to start mount:', error)
            await reportError(error, {
                title: 'Mount Error',
                fallback: 'Failed to start mount operation',
                capture: false,
            })
        },
    })

    // rclone runs no metadata mapper without `metadata`, so the pair has to hold before a mount
    // can start (`metadataOptionsProblem`).
    const metadataProblem = metadataOptionsProblem(metadataOptions)
    // What rclone would refuse, or read as something else than meant: the field says what, the
    // button says which.
    const pathProblem = pathsProblem([source])
        ? 'Fix the source path'
        : pathsProblem([dest])
          ? 'Fix the destination path'
          : undefined

    const buttonText = useMemo(() => {
        if (startMountMutation.isPending) return 'MOUNTING...'
        if (!source) return 'Please select a source path'
        if (!dest) return 'Please select a destination path'
        if (source === dest) return 'Source and destination cannot be the same'
        if (pathProblem) return pathProblem
        if (jsonError) return 'Invalid JSON for ' + jsonError.toUpperCase() + ' options'
        if (metadataProblem) return metadataProblem
        return 'START MOUNT'
    }, [startMountMutation.isPending, source, dest, pathProblem, jsonError, metadataProblem])

    const buttonIcon = useMemo(() => {
        if (startMountMutation.isPending || startMountMutation.isSuccess) return
        if (!source || !dest || source === dest) return <FoldersIcon className="w-5 h-5" />
        if (jsonError) return <AlertOctagonIcon className="w-4 h-4 mt-0.5" />
        return <PlayIcon className="w-4 h-4 fill-current" />
    }, [startMountMutation.isPending, startMountMutation.isSuccess, source, dest, jsonError])

    return (
        <div className="flex flex-col h-screen gap-10">
            {/* Main Content */}
            <OperationWindowContent>
                {/* Paths Display */}
                <PathFinder
                    sourcePath={source}
                    setSourcePath={setSource}
                    destPath={dest}
                    setDestPath={setDest}
                    switchable={false}
                    sourceOptions={{
                        label: 'Remote Path',
                        showPicker: true,
                        placeholder: 'Root path inside the remote',
                        clearable: true,
                        allowedKeys: ['REMOTES', 'FAVORITES'],
                        showFiles: false,
                    }}
                    destOptions={{
                        label: 'Mount Point',
                        showPicker: true,
                        placeholder: 'The local path to mount the remote to',
                        clearable: false,
                        allowedKeys: ['LOCAL_FS', 'LOCAL_FS_EXTRA'],
                        showFiles: false,
                    }}
                />

                <Accordion
                    keepContentMounted={true}
                    dividerProps={{
                        className: 'opacity-50',
                    }}
                >
                    <AccordionItem
                        key="mount"
                        startContent={
                            <Avatar color="secondary" radius="lg" fallback={<HardDriveIcon />} />
                        }
                        indicator={<HardDriveIcon />}
                        title="Mount"
                        subtitle={getOptionsSubtitle(Object.keys(mountOptions).length)}
                    >
                        <OptionsSection
                            optionsJson={mountOptionsJsonString}
                            setOptionsJson={setMountOptionsJsonString}
                            globalOptions={globalFlags?.mount || {}}
                            availableOptions={mountFlags || []}
                            isLocked={mountOptionsLocked}
                            setIsLocked={setMountOptionsLocked}
                        />
                    </AccordionItem>
                    <AccordionItem
                        key="vfs"
                        startContent={
                            <Avatar color="warning" radius="lg" fallback={<WavesLadderIcon />} />
                        }
                        indicator={<WavesLadderIcon />}
                        title="VFS"
                        subtitle={getOptionsSubtitle(Object.keys(vfsOptions).length)}
                    >
                        <OptionsSection
                            optionsJson={vfsOptionsJsonString}
                            setOptionsJson={setVfsOptionsJsonString}
                            globalOptions={globalFlags?.vfs || {}}
                            availableOptions={vfsFlags || []}
                            isLocked={vfsOptionsLocked}
                            setIsLocked={setVfsOptionsLocked}
                        />
                    </AccordionItem>
                    <AccordionItem
                        key="filters"
                        startContent={
                            <Avatar color="danger" radius="lg" fallback={<FilterIcon />} />
                        }
                        indicator={<FilterIcon />}
                        title="Filters"
                        subtitle={getOptionsSubtitle(Object.keys(filterOptions).length)}
                    >
                        <OptionsSection
                            globalOptions={globalFlags?.filter || {}}
                            optionsJson={filterOptionsJsonString}
                            setOptionsJson={setFilterOptionsJsonString}
                            availableOptions={filterFlags || []}
                            isLocked={filterOptionsLocked}
                            setIsLocked={setFilterOptionsLocked}
                        />
                    </AccordionItem>
                    <AccordionItem
                        key="config"
                        startContent={
                            <Avatar color="default" radius="lg" fallback={<WrenchIcon />} />
                        }
                        indicator={<WrenchIcon />}
                        title="Config"
                        subtitle={getOptionsSubtitle(Object.keys(configOptions).length)}
                    >
                        <OptionsSection
                            globalOptions={globalFlags?.main || {}}
                            optionsJson={configOptionsJsonString}
                            setOptionsJson={setConfigOptionsJsonString}
                            availableOptions={configFlags || []}
                            isLocked={configOptionsLocked}
                            setIsLocked={setConfigOptionsLocked}
                        />
                    </AccordionItem>
                    <AccordionItem
                        key="metadata"
                        startContent={
                            <Avatar
                                radius="lg"
                                fallback={<TagsIcon className="text-success-foreground" />}
                                className="bg-violet-500"
                            />
                        }
                        indicator={<TagsIcon />}
                        title="Metadata"
                        subtitle={getOptionsSubtitle(Object.keys(metadataOptions).length)}
                    >
                        <OptionsSection
                            globalOptions={{ ...globalFlags?.main, ...globalFlags?.filter }}
                            optionsJson={metadataOptionsJsonString}
                            setOptionsJson={setMetadataOptionsJsonString}
                            mapperPaths={{ destination: source }}
                            availableOptions={metadataFlags || []}
                            isLocked={metadataOptionsLocked}
                            setIsLocked={setMetadataOptionsLocked}
                        />
                    </AccordionItem>
                </Accordion>
            </OperationWindowContent>

            <OperationWindowFooter>
                <TemplatesDropdown
                    isDisabled={!!jsonError}
                    operation="mount"
                    onSelect={(groupedOptions, shouldMerge, paths) => {
                        const nextPaths = applyTemplatePaths(
                            { sources: source ? [source] : [], destination: dest },
                            paths,
                            shouldMerge
                        )
                        setSource(nextPaths.sources?.[0])
                        setDest(nextPaths.destination)
                        startTransition(() => {
                            if (shouldMerge) {
                                if (groupedOptions.mount)
                                    setMountOptionsJsonString(
                                        JSON.stringify(
                                            { ...mountOptions, ...groupedOptions.mount },
                                            null,
                                            2
                                        )
                                    )
                                if (groupedOptions.vfs)
                                    setVfsOptionsJsonString(
                                        JSON.stringify(
                                            { ...vfsOptions, ...groupedOptions.vfs },
                                            null,
                                            2
                                        )
                                    )
                                if (groupedOptions.filter)
                                    setFilterOptionsJsonString(
                                        JSON.stringify(
                                            { ...filterOptions, ...groupedOptions.filter },
                                            null,
                                            2
                                        )
                                    )
                                if (groupedOptions.config)
                                    setConfigOptionsJsonString(
                                        JSON.stringify(
                                            { ...configOptions, ...groupedOptions.config },
                                            null,
                                            2
                                        )
                                    )
                                if (groupedOptions.metadata)
                                    setMetadataOptionsJsonString(
                                        JSON.stringify(
                                            { ...metadataOptions, ...groupedOptions.metadata },
                                            null,
                                            2
                                        )
                                    )
                            } else {
                                if (groupedOptions.mount)
                                    setMountOptionsJsonString(
                                        JSON.stringify(groupedOptions.mount, null, 2)
                                    )
                                if (groupedOptions.vfs)
                                    setVfsOptionsJsonString(
                                        JSON.stringify(groupedOptions.vfs, null, 2)
                                    )
                                if (groupedOptions.filter)
                                    setFilterOptionsJsonString(
                                        JSON.stringify(groupedOptions.filter, null, 2)
                                    )
                                if (groupedOptions.config)
                                    setConfigOptionsJsonString(
                                        JSON.stringify(groupedOptions.config, null, 2)
                                    )
                                if (groupedOptions.metadata)
                                    setMetadataOptionsJsonString(
                                        JSON.stringify(groupedOptions.metadata, null, 2)
                                    )
                            }
                        })
                    }}
                    getOptions={() => ({
                        ...mountOptions,
                        ...vfsOptions,
                        ...filterOptions,
                        ...configOptions,
                        ...metadataOptions,
                    })}
                    getPaths={() => ({
                        sources: source ? [source] : undefined,
                        destination: dest,
                    })}
                />
                <AnimatePresence mode="wait" initial={false}>
                    {startMountMutation.isSuccess ? (
                        <motion.div
                            key="started-buttons"
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            transition={{ duration: 0.2, ease: 'easeOut' }}
                            className="flex flex-1 gap-2"
                        >
                            <Dropdown shadow={platform === 'windows' ? 'none' : undefined}>
                                <DropdownTrigger>
                                    <Button fullWidth={true} size="lg" data-focus-visible="false">
                                        NEW MOUNT
                                    </Button>
                                </DropdownTrigger>
                                <DropdownMenu>
                                    <DropdownItem
                                        key="reset-paths"
                                        onPress={() => {
                                            startTransition(() => {
                                                setDest(undefined)
                                                setSource(undefined)
                                                setJsonError(null)
                                                startMountMutation.reset()
                                            })
                                        }}
                                    >
                                        Reset Paths
                                    </DropdownItem>
                                    <DropdownItem
                                        key="reset-options"
                                        onPress={() => {
                                            startTransition(() => {
                                                setMountOptionsJsonString('{}')
                                                setVfsOptionsJsonString('{}')
                                                setFilterOptionsJsonString('{}')
                                                setConfigOptionsJsonString(
                                                    JSON.stringify(
                                                        RCLONE_CONFIG_DEFAULTS.config,
                                                        null,
                                                        2
                                                    )
                                                )
                                                setMetadataOptionsJsonString('{}')
                                                setJsonError(null)
                                                startMountMutation.reset()
                                            })
                                        }}
                                    >
                                        Reset Options
                                    </DropdownItem>
                                    <DropdownItem
                                        key="reset-all"
                                        onPress={() => {
                                            startTransition(() => {
                                                setMountOptionsJsonString('{}')
                                                setVfsOptionsJsonString('{}')
                                                setFilterOptionsJsonString('{}')
                                                setConfigOptionsJsonString(
                                                    JSON.stringify(
                                                        RCLONE_CONFIG_DEFAULTS.config,
                                                        null,
                                                        2
                                                    )
                                                )
                                                setMetadataOptionsJsonString('{}')
                                                setMountOptionsLocked(false)
                                                setVfsOptionsLocked(false)
                                                setFilterOptionsLocked(false)
                                                setConfigOptionsLocked(false)
                                                setMetadataOptionsLocked(false)
                                                setJsonError(null)
                                                setDest(undefined)
                                                setSource(undefined)
                                                startMountMutation.reset()
                                            })
                                        }}
                                    >
                                        Reset All
                                    </DropdownItem>
                                </DropdownMenu>
                            </Dropdown>

                            <Button
                                fullWidth={true}
                                size="lg"
                                color="primary"
                                onPress={async () => {
                                    const mountPoint = startMountMutation.data
                                    if (!mountPoint) return
                                    try {
                                        await openPath(mountPoint)
                                    } catch (err) {
                                        console.error('[Mount] Error opening path:', err)
                                        await message(`Failed to open ${mountPoint} (${err})`, {
                                            title: 'Open Error',
                                            kind: 'error',
                                        })
                                    }
                                    await closeSelf()
                                }}
                                data-focus-visible="false"
                            >
                                OPEN
                            </Button>
                        </motion.div>
                    ) : (
                        <motion.div
                            key="start-button"
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            transition={{ duration: 0.2, ease: 'easeOut' }}
                            className="flex flex-1"
                        >
                            <Button
                                onPress={() => startMountMutation.mutate({ dest, source })}
                                size="lg"
                                fullWidth={true}
                                color="primary"
                                isDisabled={
                                    startMountMutation.isPending ||
                                    !!jsonError ||
                                    !!metadataProblem ||
                                    !!pathProblem ||
                                    !source ||
                                    !dest ||
                                    source === dest ||
                                    startMountMutation.isSuccess
                                }
                                isLoading={startMountMutation.isPending}
                                endContent={buttonIcon}
                                className="gap-2"
                                data-focus-visible="false"
                            >
                                {buttonText}
                            </Button>
                        </motion.div>
                    )}
                </AnimatePresence>
                <ButtonGroup variant="flat">
                    <Tooltip content="Schedule task" placement="top" size="lg" color="foreground">
                        <Button
                            size="lg"
                            type="button"
                            color="primary"
                            isIconOnly={true}
                            onPress={async () => {
                                await message(
                                    'You can auto mount remotes by going to Settings > Remotes > Config',
                                    {
                                        title: 'Auto Mount',
                                        kind: 'info',
                                    }
                                )
                            }}
                        >
                            <ClockIcon className="size-6" />
                        </Button>
                    </Tooltip>
                    <CommandInfoButton
                        command="mount"
                        content={`Mounts a remote as a local file system.

Mount allows you to access any of rclone's cloud storage systems as if they were a local folder on your computer. Files appear in your file browser and can be opened directly by applications. On Windows this requires WinFsp; macOS mounts use the system's built-in NFS client, so no extra software is needed.

On Linux/macOS/FreeBSD, the mount point must be an empty existing directory. On Windows, you can mount to an unused drive letter, or to a path representing a nonexistent subdirectory of an existing parent directory.

Here's a quick guide to using the Mount command:

1. SELECT PATHS
• Remote Path — The remote (and optional subfolder) you want to mount. For example, "gdrive:" to mount your entire Google Drive, or "gdrive:/Documents" to mount just that folder.

• Mount Point — The local path where the remote will appear. On macOS/Linux, create an empty folder first. On Windows, you can use a drive letter like "M:" or enter "*" to automatically assign the next available drive letter (starting from Z: and moving backward).

2. CONFIGURE OPTIONS (Optional)
Expand the accordion sections to customize your mount. Tap any chip on the right to add it to the JSON editor. Hover over chips to see what each option does.

• Mount — Mount-specific settings like allowing non-empty directories, setting permissions, and controlling how the mount appears to your system.

• VFS — Virtual File System caching options. The most important is vfs_cache_mode. Without it, the mount is essentially read-only for most applications. Set to "writes" or "full" if you need to edit files. "full" caches entire files locally for best compatibility.

• Filters — Include or exclude files by pattern, limit by size (max_size, min_size) or age (max_age, min_age).

• Config — Performance tuning: parallel transfers, checkers, buffer_size, and other global rclone settings.

• Metadata — Whether to preserve object metadata (metadata), a program that rewrites it (metadata_mapper), and metadata include/exclude/filter rules.

3. START THE MOUNT
Once paths are selected, tap "START MOUNT" to begin. After mounting, you can tap "Open" to open the mount point in your file browser. The mount remains active until you unmount it (from the Mounts page) or quit the app.

Note: Bucket-based remotes (S3, GCS, Azure Blob, B2) cannot store empty directories — they will disappear from the mount once they fall out of the directory cache.`}
                    />
                    <CommandsDropdown currentCommand="mount" />
                </ButtonGroup>
            </OperationWindowFooter>
        </div>
    )
}
