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
    Input,
    Select,
    SelectItem,
} from '@heroui/react'
import { useMutation } from '@tanstack/react-query'

import { AnimatePresence, motion } from 'framer-motion'
import {
    AlertOctagonIcon,
    FilterIcon,
    FoldersIcon,
    PlayIcon,
    ServerCrashIcon,
    TagsIcon,
    WavesLadderIcon,
    WrenchIcon,
} from 'lucide-react'
import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { writeText } from '../../lib/api/clipboard'
import { pathsProblem } from '../../lib/paths'
import { onErrorDialog } from '../../lib/errors'
import { notify } from '../../lib/notifications'
import { getOptionsSubtitle } from '../../lib/flags'
import { useFlags } from '../../lib/hooks'
import { applyTemplatePaths, pathsFromArgs } from '../../lib/rclone/templatePaths'
import { startServe } from '../../lib/rclone/api'
import { RCLONE_CONFIG_DEFAULTS, SERVE_TYPES } from '../../lib/rclone/constants'
import { metadataOptionsProblem } from '../../lib/rclone/metadataMapper'
import type { FlagValue } from '../../types/rclone'
import CommandInfoButton from '../components/CommandInfoButton'
import OperationWindowContent from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import OptionsSection from '../components/OptionsSection'
import { PathField } from '../components/PathFinder'
import TemplatesDropdown from '../components/TemplatesDropdown'
import { useOperationPreset } from '../components/operation/useOperationPreset'

export default function Serve() {
    const { preset, onStarted } = useOperationPreset('serve')
    const { globalFlags, filterFlags, configFlags, vfsFlags, serveFlags, metadataFlags } =
        useFlags()

    const [source, setSource] = useState<string | undefined>(preset?.args.source)
    const [type, setType] = useState<(typeof SERVE_TYPES)[number] | undefined>(() => {
        const given = preset?.args.type
        return given && (SERVE_TYPES as readonly string[]).includes(given)
            ? (given as (typeof SERVE_TYPES)[number])
            : undefined
    })

    const [jsonError, setJsonError] = useState<
        'serve' | 'vfs' | 'filter' | 'config' | 'metadata' | null
    >(null)

    const [serveOptionsLocked, setServeOptionsLocked] = useState(false)
    const [serveOptions, setServeOptions] = useState<Record<string, FlagValue>>({})
    const [serveOptionsJsonString, setServeOptionsJsonString] = useState<string>('{}')

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

    const startServeMutation = useMutation({
        mutationFn: async () => {
            if (!source || !type) {
                throw new Error('Please select both a source and serve type')
            }
            const problem = pathsProblem([source])
            if (problem) throw new Error(problem)

            const started = (await startServe({
                type,
                fs: source,
                _filter: filterOptions as any,
                _config: configOptions as any,
                _metadata: metadataOptions as any,
                ...(serveOptions as { addr: string } & Record<string, FlagValue>),
                ...(vfsOptions as Record<string, FlagValue>),
            })) as { addr?: string } | undefined
            // Where rclone is really listening: asked for port 0, it says which one it took.
            return started?.addr || (serveOptions as { addr: string }).addr
        },
        onSuccess: () => {
            onStarted(
                () => ({
                    ...serveOptions,
                    ...vfsOptions,
                    ...filterOptions,
                    ...configOptions,
                    ...metadataOptions,
                }),
                () => pathsFromArgs({ source })
            )
        },
        onError: onErrorDialog('Serve', 'Failed to start serve', {
            log: ['[Serve] Failed to start serve:'],
        }),
    })

    // Seeds the option strings once: the preset's groups where it carries them, the defaults
    // otherwise (the parse effect derives the values).
    useEffect(() => {
        const given = preset?.args.options
        const json = (options: Record<string, FlagValue> | undefined, fallback = {}) =>
            JSON.stringify(options ?? fallback, null, 2)
        startTransition(() => {
            setServeOptionsJsonString(json(given?.serve))
            setVfsOptionsJsonString(json(given?.vfs))
            setFilterOptionsJsonString(json(given?.filter))
            setConfigOptionsJsonString(json(given?.config, RCLONE_CONFIG_DEFAULTS.config))
            setMetadataOptionsJsonString(json(given?.metadata))
        })
    }, [preset])

    useEffect(() => {
        let step: 'serve' | 'vfs' | 'filter' | 'config' | 'metadata' = 'serve'
        try {
            const parsedServe = JSON.parse(serveOptionsJsonString) as Record<string, FlagValue>

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
                setServeOptions(parsedServe)
                setVfsOptions(parsedVfs)
                setFilterOptions(parsedFilter)
                setConfigOptions(parsedConfig)
                setMetadataOptions(parsedMetadata)
                setJsonError(null)
            })
        } catch (error) {
            setJsonError(step)
            console.error(`[Serve] Error parsing ${step} options:`, error)
        }
    }, [
        serveOptionsJsonString,
        vfsOptionsJsonString,
        filterOptionsJsonString,
        configOptionsJsonString,
        metadataOptionsJsonString,
    ])

    // The Address field and the `addr` flag under Serve options are one value, and the options
    // JSON is where it lives. The field reads it off the string rather than the parsed copy:
    // parsing lands a render later (it is a transition), which a controlled input cannot wait for.
    const addr = useMemo(() => {
        try {
            const parsed = JSON.parse(serveOptionsJsonString) as Record<string, FlagValue>
            return typeof parsed.addr === 'string' ? parsed.addr : ''
        } catch {
            return ''
        }
    }, [serveOptionsJsonString])

    const setAddr = useCallback((value: string) => {
        setServeOptionsJsonString((current) => {
            let parsed: Record<string, FlagValue>
            try {
                parsed = JSON.parse(current) as Record<string, FlagValue>
            } catch {
                // The JSON is the value; while it is unparseable there is nothing to write into.
                return current
            }
            const { addr: _cleared, ...without } = parsed
            return JSON.stringify(value ? { ...parsed, addr: value } : without, null, 2)
        })
    }, [])

    // rclone's own default for the chosen type (`useFlags` strips the brackets it reports).
    const addrPlaceholder = useMemo(() => {
        const flag = type ? serveFlags[type]?.find((item) => item.Name === 'addr') : undefined
        return (flag?.DefaultStr as string | undefined) || '127.0.0.1:8080'
    }, [type, serveFlags])

    // rclone runs no metadata mapper without `metadata`, so the pair has to hold before a serve
    // can start (`metadataOptionsProblem`).
    const metadataProblem = metadataOptionsProblem(metadataOptions)

    const pathProblem = pathsProblem([source]) ? 'Fix the source path' : undefined

    const buttonText = useMemo(() => {
        if (startServeMutation.isPending) return 'STARTING...'
        if (!source) return 'Please select a source'
        if (pathProblem) return pathProblem
        if (!type) return 'Please select a serve type'
        if (jsonError) return 'Invalid JSON for ' + jsonError.toUpperCase() + ' options'
        if (!addr) return 'Specify an address to serve on'
        if (metadataProblem) return metadataProblem
        return 'START SERVE'
    }, [startServeMutation.isPending, source, type, jsonError, addr, metadataProblem])

    const buttonIcon = useMemo(() => {
        if (startServeMutation.isPending || startServeMutation.isSuccess) return
        if (!source || !type) return <FoldersIcon className="w-5 h-5" />
        if (jsonError) return <AlertOctagonIcon className="w-4 h-4 mt-0.5" />
        if (!addr) return <AlertOctagonIcon className="w-4 h-4 mt-0.5" />
        return <PlayIcon className="w-4 h-4 fill-current" />
    }, [startServeMutation.isPending, startServeMutation.isSuccess, source, type, jsonError, addr])

    return (
        <div className="flex flex-col h-full gap-10">
            <OperationWindowContent>
                <PathField
                    path={source || ''}
                    setPath={setSource}
                    label="Source"
                    placeholder="Enter a remote:path as source"
                    showPicker={true}
                    showFiles={false}
                />

                <Select
                    selectedKeys={type ? [type] : []}
                    onSelectionChange={(keys) => {
                        setType(keys.currentKey as (typeof SERVE_TYPES)[number])
                    }}
                    size="lg"
                    placeholder="Select a serve type"
                    label="Type"
                    labelPlacement="inside"
                >
                    {SERVE_TYPES.map((type) => (
                        <SelectItem key={type} textValue={type.toUpperCase()}>
                            {type.toUpperCase()}
                        </SelectItem>
                    ))}
                </Select>

                <Input
                    size="lg"
                    label="Address"
                    value={addr}
                    onValueChange={setAddr}
                    placeholder={addrPlaceholder}
                    description="Where the server listens. The same value as the addr flag under Serve options."
                    isDisabled={jsonError === 'serve'}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                />

                <Accordion
                    keepContentMounted={true}
                    dividerProps={{
                        className: 'opacity-50',
                    }}
                >
                    {type ? (
                        <AccordionItem
                            key="serve"
                            startContent={
                                <Avatar
                                    radius="lg"
                                    fallback={
                                        <ServerCrashIcon className="text-success-foreground" />
                                    }
                                    className="bg-cyan-500"
                                />
                            }
                            indicator={<ServerCrashIcon />}
                            title="Serve"
                            subtitle={getOptionsSubtitle(Object.keys(serveOptions).length)}
                        >
                            <OptionsSection
                                optionsJson={serveOptionsJsonString}
                                setOptionsJson={setServeOptionsJsonString}
                                globalOptions={globalFlags?.[type] || {}}
                                availableOptions={serveFlags[type] || []}
                                isLocked={serveOptionsLocked}
                                setIsLocked={setServeOptionsLocked}
                            />
                        </AccordionItem>
                    ) : null}
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
                    operation="serve"
                    onSelect={(groupedOptions, shouldMerge, paths) => {
                        const nextPaths = applyTemplatePaths(
                            { sources: source ? [source] : [] },
                            paths,
                            shouldMerge
                        )
                        setSource(nextPaths.sources?.[0])
                        startTransition(() => {
                            if (shouldMerge) {
                                if (groupedOptions.serve && type)
                                    setServeOptionsJsonString(
                                        JSON.stringify(
                                            { ...serveOptions, ...groupedOptions.serve[type] },
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
                                if (groupedOptions.serve && type)
                                    setServeOptionsJsonString(
                                        JSON.stringify(groupedOptions.serve[type], null, 2)
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
                    getPaths={() => ({ sources: source ? [source] : undefined })}
                    getOptions={() => ({
                        ...serveOptions,
                        ...vfsOptions,
                        ...filterOptions,
                        ...configOptions,
                        ...metadataOptions,
                    })}
                />
                <AnimatePresence mode="wait" initial={false}>
                    {startServeMutation.isSuccess ? (
                        <motion.div
                            key="started-buttons"
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            transition={{ duration: 0.2, ease: 'easeOut' }}
                            className="flex flex-1 gap-2"
                        >
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button
                                        fullWidth={true}
                                        size="lg"
                                        color="primary"
                                        data-focus-visible="false"
                                    >
                                        NEW SERVE
                                    </Button>
                                </DropdownTrigger>
                                <DropdownMenu>
                                    <DropdownItem
                                        key="reset-source-type"
                                        onPress={() => {
                                            startTransition(() => {
                                                setSource(undefined)
                                                setType(undefined)
                                                setJsonError(null)
                                                startServeMutation.reset()
                                            })
                                        }}
                                    >
                                        Reset Source & Type
                                    </DropdownItem>
                                    <DropdownItem
                                        key="reset-options"
                                        onPress={() => {
                                            startTransition(() => {
                                                setServeOptionsJsonString('{}')
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
                                                startServeMutation.reset()
                                            })
                                        }}
                                    >
                                        Reset Options
                                    </DropdownItem>
                                    <DropdownItem
                                        key="reset-all"
                                        onPress={() => {
                                            startTransition(() => {
                                                setSource(undefined)
                                                setType(undefined)
                                                setServeOptionsJsonString('{}')
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
                                                setServeOptionsLocked(false)
                                                setVfsOptionsLocked(false)
                                                setFilterOptionsLocked(false)
                                                setConfigOptionsLocked(false)
                                                setMetadataOptionsLocked(false)
                                                setJsonError(null)
                                                startServeMutation.reset()
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
                                color="secondary"
                                onPress={async () => {
                                    const address = startServeMutation.data
                                    if (!address) return
                                    await writeText(address)
                                    await notify({
                                        title: 'Address Copied',
                                        body: `${address} copied to clipboard`,
                                    })
                                }}
                                data-focus-visible="false"
                            >
                                COPY ADDRESS
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
                                onPress={() => startServeMutation.mutate()}
                                size="lg"
                                fullWidth={true}
                                color="primary"
                                isDisabled={
                                    startServeMutation.isPending ||
                                    !!jsonError ||
                                    !!metadataProblem ||
                                    !source ||
                                    !type ||
                                    startServeMutation.isSuccess ||
                                    !('addr' in serveOptions)
                                }
                                isLoading={startServeMutation.isPending}
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
                    <CommandInfoButton command="serve" />
                </ButtonGroup>
            </OperationWindowFooter>
        </div>
    )
}
