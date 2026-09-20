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
import { useMutation } from '@tanstack/react-query'

import {
    CopyIcon,
    FilterIcon,
    FolderSyncIcon,
    HardDriveIcon,
    ServerCrashIcon,
    TagsIcon,
    WavesLadderIcon,
    WrenchIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useDebounce } from 'use-debounce'
import { formatErrorMessage } from '@/lib/errors'

import { message } from '@/dialog'
import { TEMPLATE_TAG_OPTIONS, getJsonKeyCount, getOptionsSubtitle } from '@/lib/flags'
import { useFlags } from '@/lib/hooks'
import { metadataOptionsProblem } from '@/lib/rclone/metadataMapper'
import { hasTemplatePaths } from '@/lib/rclone/templatePaths'
import { MultiPathField, PathField } from '@/components/PathFinder'
import { usePersistedStore } from '@/store'
import type { Template } from '@/lib/rclone/templatePaths'
import OptionsSection from '@/components/OptionsSection'
import {
    draftFromOptions,
    optionsFromCommand,
    optionsFromDraft,
    serveFlagsForTemplates,
    useTemplateDraft,
} from './draft'

/** What `/templates?action=add&cmd=…&name=…` asks the drawer to start from. */
export interface TemplatePrefill {
    cmd?: string
    name?: string
}

export default function TemplateAddDrawer({
    isOpen,
    onClose,
    initialValues,
}: {
    isOpen: boolean
    onClose: () => void
    // A fresh object arrives per link, so a repeated identical link still re-applies.
    initialValues?: TemplatePrefill | null
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
        metadataFlags,
        allFlags,
    } = useFlags()
    const [importString, setImportString] = useState('')
    const [debouncedImportString] = useDebounce(importString, 500)
    const [importedCount, setImportedCount] = useState<null | number>(null)

    const { draft, setters, replace, reset } = useTemplateDraft()
    const [name, setName] = useState('')
    const [tags, setTags] = useState<string[]>([])
    // Where the template runs, kept beside the flags rather than in the draft: they are paths,
    // not rclone options, and `optionsFromDraft` must keep returning flags alone.
    const [sources, setSources] = useState<string[]>([])
    const [destination, setDestination] = useState('')

    useEffect(() => {
        if (!isOpen || !initialValues) return
        setImportString(initialValues.cmd ?? '')
        setName(initialValues.name ?? '')
    }, [isOpen, initialValues])

    const { uniqueServeFlags, mergedGlobalServeFlags } = useMemo(
        () => serveFlagsForTemplates(serveFlags, globalFlags),
        [serveFlags, globalFlags]
    )

    const addTemplateMutation = useMutation({
        mutationFn: async () => {
            if (!name) {
                await message('Please enter a name for the template', {
                    title: 'Error',
                    kind: 'error',
                })
                return false
            }

            const options = optionsFromDraft(draft)

            // A template carries its options into whatever page loads it; a mapper without
            // `metadata` would be a preset that silently does nothing.
            const problem = metadataOptionsProblem(options)
            if (problem) {
                await message(problem, { title: 'Error', kind: 'error' })
                return false
            }

            const paths = { sources: sources.filter(Boolean), destination: destination.trim() }
            const template: Template = {
                id: crypto.randomUUID(),
                name,
                tags: tags as any,
                options: options,
                // Left off entirely when neither field was filled, so a template of flags alone
                // is stored exactly as it was before templates had paths.
                ...(hasTemplatePaths(paths) ? { paths } : {}),
            }

            usePersistedStore.setState((state) => ({
                templates: [...state.templates, template],
            }))

            return true
        },
        onSuccess: (saved) => {
            if (!saved) return
            onClose()
            // Clearing the command matters: re-importing the same command later hits the cached
            // parseFlags query (same `data` reference), so the section-populate effect would not
            // re-fire against the freshly reset sections.
            setImportString('')
            setImportedCount(null)
            setName('')
            setTags([])
            setSources([])
            setDestination('')
            reset()
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

    // The command's flags become the draft, replacing it: an explicit import, debounced by
    // the input, not a fetched value.
    const imported = useMemo(
        () =>
            debouncedImportString && allFlags
                ? optionsFromCommand(debouncedImportString, allFlags)
                : null,
        [debouncedImportString, allFlags]
    )
    useEffect(() => {
        if (!imported || !allFlags) return
        try {
            replace(draftFromOptions(imported, allFlags))
        } catch {
            void message('Error parsing command', { title: 'Error', kind: 'error' })
            return
        }
        const count = Object.keys(imported).length
        if (!count) {
            return
        }
        setImportedCount(count)
        setTimeout(() => {
            setImportedCount(null)
        }, 4500)
    }, [imported, allFlags, replace])

    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={onClose}
            hideCloseButton={true}
        >
            <DrawerContent className={cn('bg-content1/80 backdrop-blur-md dark:bg-content1/90')}>
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
                                                importString !== debouncedImportString ? (
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
                                                            navigator.clipboard
                                                                .readText()
                                                                .then((text) => {
                                                                    setImportString(text)
                                                                })
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
                                            items={TEMPLATE_TAG_OPTIONS.map((category) => ({
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

                                        <MultiPathField
                                            paths={sources}
                                            setPaths={(paths) => setSources(paths ?? [])}
                                            label="Source(s)"
                                            labelPlacement="outside"
                                        />

                                        <PathField
                                            path={destination}
                                            setPath={setDestination}
                                            label="Destination"
                                            labelPlacement="outside"
                                        />
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
                                                getJsonKeyCount(draft.mount)
                                            )}
                                        >
                                            <div className="flex flex-col gap-4">
                                                <OptionsSection
                                                    optionsJson={draft.mount}
                                                    setOptionsJson={setters.mount}
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
                                                getJsonKeyCount(draft.config)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={draft.config}
                                                setOptionsJson={setters.config}
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
                                                getJsonKeyCount(draft.vfs)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={draft.vfs}
                                                setOptionsJson={setters.vfs}
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
                                                getJsonKeyCount(draft.filter)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={draft.filter}
                                                setOptionsJson={setters.filter}
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
                                                getJsonKeyCount(draft.copy)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={draft.copy}
                                                setOptionsJson={setters.copy}
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
                                                getJsonKeyCount(draft.sync)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={draft.sync}
                                                setOptionsJson={setters.sync}
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
                                                getJsonKeyCount(draft.serve)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={draft.serve}
                                                setOptionsJson={setters.serve}
                                                globalOptions={mergedGlobalServeFlags as any}
                                                availableOptions={uniqueServeFlags}
                                            />
                                        </AccordionItem>

                                        <AccordionItem
                                            key="metadata"
                                            startContent={
                                                <Avatar
                                                    radius="lg"
                                                    fallback={
                                                        <TagsIcon className="text-success-foreground" />
                                                    }
                                                    className="bg-violet-500"
                                                />
                                            }
                                            indicator={<TagsIcon />}
                                            title="Metadata"
                                            subtitle={getOptionsSubtitle(
                                                getJsonKeyCount(draft.metadata)
                                            )}
                                        >
                                            <OptionsSection
                                                optionsJson={draft.metadata}
                                                setOptionsJson={setters.metadata}
                                                globalOptions={{
                                                    ...globalFlags?.main,
                                                    ...globalFlags?.filter,
                                                }}
                                                availableOptions={metadataFlags || []}
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
                                onPress={() => addTemplateMutation.mutate()}
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
