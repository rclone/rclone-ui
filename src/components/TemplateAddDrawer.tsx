import {
    Accordion,
    AccordionItem,
    Avatar,
    Button,
    Chip,
    Divider,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Input,
    ScrollShadow,
    Select,
    SelectItem,
    Spinner,
    cn,
} from '@heroui/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { message } from '@tauri-apps/plugin-dialog'
import { platform } from '@tauri-apps/plugin-os'
import {
    CopyIcon,
    FilterIcon,
    FolderSyncIcon,
    HardDriveIcon,
    ServerCrashIcon,
    WavesLadderIcon,
    WrenchIcon,
} from 'lucide-react'
import { startTransition, useEffect, useMemo, useState } from 'react'
import { useDebounce } from 'use-debounce'
import { formatErrorMessage } from '../../lib/errors'
import type { AddTemplatePayload } from '../../lib/events'
import {
    FLAG_CATEGORIES,
    findFlagOption,
    getJsonKeyCount,
    getOptionsSubtitle,
    groupByCategory,
} from '../../lib/flags'
import { useFlags } from '../../lib/hooks'
import { SERVE_TYPES } from '../../lib/rclone/constants'
import { usePersistedStore } from '../../store/persisted'
import type { BackendOption, FlagValue } from '../../types/rclone'
import type { Template } from '../../types/template'
import OptionsSection from './OptionsSection'

// Strips one layer of matched surrounding quotes from an imported flag value: a pasted shell-style
// `--filter "+ *.jpg"` reaches the parser as `"+ *.jpg"`, which would otherwise become an invalid
// filter rule. Unmatched or absent quotes pass through unchanged.
function stripQuotes(value: string): string {
    const first = value[0]
    if (
        value.length >= 2 &&
        (first === '"' || first === "'") &&
        value[value.length - 1] === first
    ) {
        return value.slice(1, -1)
    }
    return value
}

export default function TemplateAddDrawer({
    isOpen,
    onClose,
    initialValues,
}: {
    isOpen: boolean
    onClose: () => void
    // Deep-link prefill (rclone://add-template?cmd=…). A fresh object arrives per link, so a
    // repeated identical link still re-applies.
    initialValues?: AddTemplatePayload | null
}) {
    const {
        globalFlags,
        filterFlags,
        configFlags,
        mountFlags,
        vfsFlags,
        copyFlags,
        syncFlags,
        serveFlags,
        allFlags,
    } = useFlags()
    const [importString, setImportString] = useState('')
    const [debouncedImportString] = useDebounce(importString, 500)
    const [importedCount, setImportedCount] = useState<null | number>(null)

    const [name, setName] = useState('')
    const [tags, setTags] = useState<string[]>([])

    useEffect(() => {
        if (!isOpen || !initialValues) return
        setImportString(initialValues.cmd ?? '')
        setName(initialValues.name ?? '')
    }, [isOpen, initialValues])

    const [configOptionsJson, setConfigOptionsJson] = useState<string>('{}')
    const [copyOptionsJson, setCopyOptionsJson] = useState<string>('{}')
    const [syncOptionsJson, setSyncOptionsJson] = useState<string>('{}')
    const [filterOptionsJson, setFilterOptionsJson] = useState<string>('{}')
    const [mountOptionsJson, setMountOptionsJson] = useState<string>('{}')
    const [vfsOptionsJson, setVfsOptionsJson] = useState<string>('{}')
    const [serveOptionsJson, setServeOptionsJson] = useState<string>('{}')

    const uniqueServeFlags = useMemo(() => {
        const all = Object.values(serveFlags).flat()
        const unique = new Map<string, BackendOption>()
        for (const flag of all) {
            if (!unique.has(flag.Name)) {
                unique.set(flag.Name, flag)
            }
        }
        return Array.from(unique.values()).sort((a, b) => a.Name.localeCompare(b.Name))
    }, [serveFlags])

    const mergedGlobalServeFlags = useMemo(() => {
        const merged = {}
        if (!globalFlags) return {}
        for (const type of SERVE_TYPES) {
            const flags = globalFlags[type]
            if (flags) {
                Object.assign(merged, flags)
            }
        }
        return merged
    }, [globalFlags])

    const addTemplateMutation = useMutation({
        mutationFn: async () => {
            if (!name) {
                await message('Please enter a name for the template', {
                    title: 'Error',
                    kind: 'error',
                })
                return
            }

            const options: Record<string, any> = {
                ...(JSON.parse(mountOptionsJson) as Record<string, any>),
                ...(JSON.parse(configOptionsJson) as Record<string, any>),
                ...(JSON.parse(vfsOptionsJson) as Record<string, any>),
                ...(JSON.parse(filterOptionsJson) as Record<string, any>),
                ...(JSON.parse(copyOptionsJson) as Record<string, any>),
                ...(JSON.parse(syncOptionsJson) as Record<string, any>),
                ...(JSON.parse(serveOptionsJson) as Record<string, any>),
            }

            const template: Template = {
                id: crypto.randomUUID(),
                name,
                tags: tags as any,
                options: options,
            }

            usePersistedStore.setState((state) => ({
                templates: [...state.templates, template],
            }))

            return true
        },
        onSuccess: () => {
            onClose()
            // Clearing the command matters: re-importing the same command later hits the cached
            // parseFlags query (same `data` reference), so the section-populate effect would not
            // re-fire against the freshly reset sections.
            setImportString('')
            setImportedCount(null)
            setName('')
            setTags([])
            setMountOptionsJson('{}')
            setConfigOptionsJson('{}')
            setVfsOptionsJson('{}')
            setFilterOptionsJson('{}')
            setCopyOptionsJson('{}')
            setSyncOptionsJson('{}')
            setServeOptionsJson('{}')
        },
        onError: async (error) => {
            await message(
                formatErrorMessage(error, 'Error saving template. Please check your options.'),
                {
                    title: 'Error',
                    kind: 'error',
                }
            )
            console.error(error)
        },
    })

    useEffect(() => {
        console.log('debounced import string', debouncedImportString)
    }, [debouncedImportString])

    const commandFlagsQuery = useQuery({
        queryKey: ['parseFlags', debouncedImportString],
        queryFn: async () => {
            console.log('debounced import string')

            const flagsIndex = debouncedImportString.indexOf('--')
            const flagString = debouncedImportString.slice(flagsIndex)

            const flagGroups: Record<string, FlagValue> = {}

            const flagStrings = flagString.split('--').filter(Boolean)

            for (const flagString of flagStrings) {
                const [flagToken, ...valueParts] = flagString.trim().split(/\s+/)
                const equalsIndex = flagToken.indexOf('=')
                const flag = equalsIndex === -1 ? flagToken : flagToken.slice(0, equalsIndex)
                const normalizedFlag = flag.replace(/-/g, '_')
                let value = equalsIndex === -1 ? undefined : flagToken.slice(equalsIndex + 1)
                if (value === undefined && valueParts.length > 0) {
                    value = valueParts.join(' ')
                }
                if (value !== undefined) {
                    value = stripQuotes(value)
                }
                const flagInfo = findFlagOption(normalizedFlag, allFlags ?? {})

                let parsedValue: FlagValue = value ?? true
                if (flagInfo?.Type === 'bool') {
                    parsedValue = value !== 'false'
                } else if (flagInfo?.Type === 'Tristate') {
                    parsedValue = value === 'null' ? null : value !== 'false'
                } else if (flagInfo?.Type === 'stringArray') {
                    parsedValue = value === undefined ? [] : [value]
                } else if (flagInfo?.Type === 'SpaceSepList') {
                    parsedValue = value?.split(/\s+/).filter(Boolean) ?? []
                } else if (flagInfo?.Type && /^(u?int|float)/i.test(flagInfo.Type) && value) {
                    const numberValue = Number(value)
                    parsedValue = Number.isNaN(numberValue) ? value : numberValue
                }

                const previousValue = flagGroups[normalizedFlag]
                flagGroups[normalizedFlag] =
                    Array.isArray(previousValue) && Array.isArray(parsedValue)
                        ? [...previousValue, ...parsedValue]
                        : parsedValue
            }

            console.log('flag groups', JSON.stringify(flagGroups, null, 2))

            return flagGroups
        },
        enabled: !!debouncedImportString && !!allFlags,
        staleTime: 300_000,
    })

    useEffect(() => {
        if (!allFlags) return
        if (!commandFlagsQuery.data) return
        console.log('[useEffect] command flags query data present')

        const groupedFlags = groupByCategory(commandFlagsQuery.data, allFlags)

        try {
            const mountJson = JSON.stringify(groupedFlags.mount, null, 2)
            const configJson = JSON.stringify(groupedFlags.config, null, 2)
            const vfsJson = JSON.stringify(groupedFlags.vfs, null, 2)
            const filterJson = JSON.stringify(groupedFlags.filter, null, 2)
            const copyJson = JSON.stringify(groupedFlags.copy, null, 2)
            const syncJson = JSON.stringify(groupedFlags.sync, null, 2)
            const serveJson = JSON.stringify(
                Object.values(groupedFlags.serve).reduce((acc, curr) => {
                    Object.assign(acc, curr)
                    return acc
                }, {}),
                null,
                2
            )

            startTransition(() => {
                setMountOptionsJson(mountJson)
                setConfigOptionsJson(configJson)
                setVfsOptionsJson(vfsJson)
                setFilterOptionsJson(filterJson)
                setCopyOptionsJson(copyJson)
                setSyncOptionsJson(syncJson)
                setServeOptionsJson(serveJson)
            })
        } catch {
            setTimeout(async () => {
                await message('Error parsing command', {
                    title: 'Error',
                    kind: 'error',
                })
            }, 0)
            return
        }

        const count = Object.keys(commandFlagsQuery.data).length

        if (!count) {
            return
        }

        setImportedCount(Object.keys(commandFlagsQuery.data).length)
        setTimeout(() => {
            setImportedCount(null)
        }, 4500)
    }, [commandFlagsQuery.data, allFlags])

    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={onClose}
            hideCloseButton={true}
        >
            <DrawerContent
                className={cn(
                    'bg-content1/80 backdrop-blur-md dark:bg-content1/90',
                    platform() === 'macos' && 'pt-5'
                )}
            >
                {(close) => (
                    <>
                        <DrawerHeader className="px-0 pb-0">
                            <div className="flex flex-col w-full gap-2">
                                <div className="flex flex-row items-baseline w-full gap-4 pl-6 pr-4 pb-0.5">
                                    <p className="shrink-0">Add Template</p>
                                    <p className="text-small text-foreground-500 line-clamp-1">
                                        Add a template to your rclone configuration. You can import
                                        a template from a command or paste a template from your
                                        clipboard.
                                    </p>
                                </div>
                                <Divider />
                            </div>
                        </DrawerHeader>
                        <DrawerBody id="template-add-drawer-body" className="py-0">
                            <ScrollShadow id="scroll-shadow" size={30} visibility="top">
                                <div className="flex flex-col gap-8 pt-6">
                                    <div className="flex flex-col gap-5">
                                        <Input
                                            label="Import from command"
                                            labelPlacement="outside"
                                            placeholder="rclone copy --vfs-cache-mode writes ..."
                                            value={importString}
                                            onValueChange={(value) => setImportString(value)}
                                            size="lg"
                                            data-focus-visible="false"
                                            autoComplete="off"
                                            autoCorrect="off"
                                            autoCapitalize="off"
                                            spellCheck="false"
                                            endContent={
                                                commandFlagsQuery.isLoading ? (
                                                    <Spinner size="sm" color="white" />
                                                ) : importedCount !== null ? (
                                                    <p className="pr-2 text-sm text-primary-500 shrink-0">
                                                        {importedCount} flag
                                                        {importedCount === 1 ? '' : 's'} imported
                                                    </p>
                                                ) : (
                                                    <Button
                                                        variant="faded"
                                                        color="primary"
                                                        size="sm"
                                                        onPress={() => {
                                                            setTimeout(() => {
                                                                navigator.clipboard
                                                                    .readText()
                                                                    .then((text) => {
                                                                        setImportString(text)
                                                                    })
                                                            }, 10)
                                                        }}
                                                    >
                                                        PASTE
                                                    </Button>
                                                )
                                            }
                                        />

                                        <Input
                                            label="Name"
                                            labelPlacement="outside"
                                            placeholder="My Template"
                                            value={name}
                                            onValueChange={(value) => setName(value)}
                                            size="lg"
                                            data-focus-visible="false"
                                            autoComplete="off"
                                            autoCorrect="off"
                                            autoCapitalize="off"
                                            spellCheck="false"
                                            isClearable={true}
                                            onClear={() => setName('')}
                                        />

                                        <Select
                                            size="lg"
                                            isMultiline={false}
                                            items={[
                                                ...FLAG_CATEGORIES.filter(
                                                    (c) => !c.startsWith('serve.')
                                                ),
                                                'serve',
                                            ].map((category) => ({
                                                key: category,
                                                label: category,
                                            }))}
                                            label="Tags"
                                            labelPlacement="outside"
                                            placeholder="Select tags"
                                            data-focus-visible="false"
                                            autoComplete="off"
                                            autoCorrect="off"
                                            autoCapitalize="off"
                                            spellCheck="false"
                                            renderValue={(items) => {
                                                return (
                                                    <div className="flex flex-row w-full gap-2">
                                                        {items.map((item) => (
                                                            <Chip key={item.key} color="primary">
                                                                {item.data?.label.toUpperCase()}
                                                            </Chip>
                                                        ))}
                                                    </div>
                                                )
                                            }}
                                            selectedKeys={tags}
                                            selectionMode="multiple"
                                            onSelectionChange={(value) => {
                                                setTags(
                                                    Array.from(value).map((item) => item.toString())
                                                )
                                            }}
                                        >
                                            {(tagCategory) => (
                                                <SelectItem
                                                    variant="flat"
                                                    key={tagCategory.key}
                                                    textValue={tagCategory.label}
                                                >
                                                    <span className="text-small">
                                                        {tagCategory.label.toUpperCase()}
                                                    </span>
                                                </SelectItem>
                                            )}
                                        </Select>
                                    </div>

                                    <Accordion selectionMode="multiple" defaultExpandedKeys={'all'}>
                                        <AccordionItem
                                            key="mount"
                                            startContent={
                                                <Avatar
                                                    color="secondary"
                                                    radius="lg"
                                                    fallback={<HardDriveIcon />}
                                                />
                                            }
                                            indicator={<HardDriveIcon />}
                                            title="Mount"
                                            subtitle={getOptionsSubtitle(
                                                getJsonKeyCount(mountOptionsJson)
                                            )}
                                        >
                                            <div className="flex flex-col gap-4">
                                                <OptionsSection
                                                    optionsJson={mountOptionsJson}
                                                    setOptionsJson={setMountOptionsJson}
                                                    globalOptions={globalFlags?.mount ?? {}}
                                                    availableOptions={mountFlags || []}
                                                />
                                            </div>
                                        </AccordionItem>

                                        <AccordionItem
                                            key="config"
                                            startContent={
                                                <Avatar
                                                    color="default"
                                                    radius="lg"
                                                    fallback={<WrenchIcon />}
                                                />
                                            }
                                            indicator={<WrenchIcon />}
                                            title="Config"
                                            subtitle={getOptionsSubtitle(
                                                getJsonKeyCount(configOptionsJson)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={configOptionsJson}
                                                setOptionsJson={setConfigOptionsJson}
                                                globalOptions={globalFlags?.main || {}}
                                                availableOptions={configFlags || []}
                                            />
                                        </AccordionItem>
                                        <AccordionItem
                                            key="vfs"
                                            startContent={
                                                <Avatar
                                                    color="warning"
                                                    radius="lg"
                                                    fallback={<WavesLadderIcon />}
                                                />
                                            }
                                            indicator={<WavesLadderIcon />}
                                            title="VFS"
                                            subtitle={getOptionsSubtitle(
                                                getJsonKeyCount(vfsOptionsJson)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={vfsOptionsJson}
                                                setOptionsJson={setVfsOptionsJson}
                                                globalOptions={globalFlags?.vfs || {}}
                                                availableOptions={vfsFlags || []}
                                            />
                                        </AccordionItem>
                                        <AccordionItem
                                            key="filters"
                                            startContent={
                                                <Avatar
                                                    color="danger"
                                                    radius="lg"
                                                    fallback={<FilterIcon />}
                                                />
                                            }
                                            indicator={<FilterIcon />}
                                            title="Filters"
                                            subtitle={getOptionsSubtitle(
                                                getJsonKeyCount(filterOptionsJson)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={filterOptionsJson}
                                                setOptionsJson={setFilterOptionsJson}
                                                globalOptions={globalFlags?.filter || {}}
                                                availableOptions={filterFlags || []}
                                            />
                                        </AccordionItem>
                                        <AccordionItem
                                            key="copy"
                                            startContent={
                                                <Avatar
                                                    color="primary"
                                                    radius="lg"
                                                    fallback={<CopyIcon />}
                                                />
                                            }
                                            indicator={<CopyIcon />}
                                            title="Copy — Move — Bisync"
                                            subtitle={getOptionsSubtitle(
                                                getJsonKeyCount(copyOptionsJson)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={copyOptionsJson}
                                                setOptionsJson={setCopyOptionsJson}
                                                globalOptions={globalFlags?.main || {}}
                                                availableOptions={copyFlags || []}
                                            />
                                        </AccordionItem>

                                        <AccordionItem
                                            key="sync"
                                            startContent={
                                                <Avatar
                                                    color="success"
                                                    radius="lg"
                                                    fallback={<FolderSyncIcon />}
                                                />
                                            }
                                            indicator={<FolderSyncIcon />}
                                            title="Sync"
                                            subtitle={getOptionsSubtitle(
                                                getJsonKeyCount(syncOptionsJson)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={syncOptionsJson}
                                                setOptionsJson={setSyncOptionsJson}
                                                globalOptions={globalFlags?.main || {}}
                                                availableOptions={syncFlags || []}
                                            />
                                        </AccordionItem>

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
                                            subtitle={getOptionsSubtitle(
                                                getJsonKeyCount(serveOptionsJson)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={serveOptionsJson}
                                                setOptionsJson={setServeOptionsJson}
                                                globalOptions={mergedGlobalServeFlags as any}
                                                availableOptions={uniqueServeFlags}
                                            />
                                        </AccordionItem>
                                    </Accordion>
                                </div>
                            </ScrollShadow>
                        </DrawerBody>
                        <DrawerFooter>
                            <Button
                                color="danger"
                                variant="light"
                                onPress={() => {
                                    close()
                                }}
                                data-focus-visible="false"
                            >
                                Cancel
                            </Button>
                            <Button
                                color="primary"
                                isLoading={addTemplateMutation.isPending}
                                onPress={() => setTimeout(() => addTemplateMutation.mutate(), 100)}
                                data-focus-visible="false"
                            >
                                {addTemplateMutation.isPending ? 'Saving...' : 'Add Template'}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
