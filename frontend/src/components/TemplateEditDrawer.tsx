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
    Select,
    SelectItem,
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
import { startTransition, useEffect, useMemo, useState } from 'react'
import { message } from '../../lib/api/dialog'
import { formatErrorMessage } from '../../lib/errors'
import { TEMPLATE_TAG_OPTIONS, getJsonKeyCount, getOptionsSubtitle } from '../../lib/flags'
import { useFlags } from '../../lib/hooks'
import { metadataOptionsProblem } from '../../lib/rclone/metadataMapper'
import { hasTemplatePaths } from '../../lib/rclone/templatePaths'
import { MultiPathField, PathField } from './PathFinder'
import { usePersistedStore } from '../../store/persisted'
import type { Template } from '../../types/template'
import OptionsSection from './OptionsSection'
import {
    draftFromOptions,
    optionsFromDraft,
    serveFlagsForTemplates,
    useTemplateDraft,
} from './template/draft'

export default function TemplateEditDrawer({
    isOpen,
    onClose,
    selectedTemplate,
}: {
    isOpen: boolean
    onClose: () => void
    selectedTemplate: Template
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

    const { draft, setters, replace } = useTemplateDraft()
    const [name, setName] = useState(selectedTemplate.name)
    const [tags, setTags] = useState<string[]>(selectedTemplate.tags)
    const [sources, setSources] = useState<string[]>(selectedTemplate.paths?.sources ?? [])
    const [destination, setDestination] = useState(selectedTemplate.paths?.destination ?? '')

    const { uniqueServeFlags, mergedGlobalServeFlags } = useMemo(
        () => serveFlagsForTemplates(serveFlags, globalFlags),
        [serveFlags, globalFlags]
    )

    useEffect(() => {
        if (!selectedTemplate || !allFlags) return

        setName(selectedTemplate.name)
        setTags(selectedTemplate.tags)
        setSources(selectedTemplate.paths?.sources ?? [])
        setDestination(selectedTemplate.paths?.destination ?? '')

        startTransition(() => replace(draftFromOptions(selectedTemplate.options, allFlags)))
    }, [selectedTemplate, allFlags, replace])

    const updateTemplateMutation = useMutation({
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

            usePersistedStore.setState((state) => ({
                templates: state.templates.map((t) =>
                    t.id === selectedTemplate.id
                        ? {
                              ...t,
                              name,
                              tags: tags as any,
                              options,
                              // Emptying both fields takes the paths off the template, rather
                              // than leaving `{}` behind for the apply rules to reason about.
                              paths: hasTemplatePaths(paths) ? paths : undefined,
                          }
                        : t
                ),
            }))

            return true
        },
        onSuccess: (saved) => {
            if (!saved) return
            onClose()
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
                                    <p className="shrink-0">Edit Template</p>
                                    <p className="text-small text-foreground-500 line-clamp-1">
                                        Edit your template configuration.
                                    </p>
                                </div>
                                <Divider />
                            </div>
                        </DrawerHeader>
                        <DrawerBody id="template-edit-drawer-body" className="py-0">
                            <div className="flex flex-col gap-8 pt-6">
                                <div className="flex flex-col gap-5">
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
                                        subtitle={getOptionsSubtitle(getJsonKeyCount(draft.mount))}
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
                                        subtitle={getOptionsSubtitle(getJsonKeyCount(draft.config))}
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
                                        subtitle={getOptionsSubtitle(getJsonKeyCount(draft.vfs))}
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
                                        subtitle={getOptionsSubtitle(getJsonKeyCount(draft.filter))}
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
                                        title="Copy"
                                        subtitle={getOptionsSubtitle(getJsonKeyCount(draft.copy))}
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
                                        subtitle={getOptionsSubtitle(getJsonKeyCount(draft.sync))}
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
                                        subtitle={getOptionsSubtitle(getJsonKeyCount(draft.serve))}
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
                                CANCEL
                            </Button>
                            <Button
                                color="primary"
                                isLoading={updateTemplateMutation.isPending}
                                onPress={() => updateTemplateMutation.mutate()}
                                data-focus-visible="false"
                            >
                                SAVE CHANGES
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
