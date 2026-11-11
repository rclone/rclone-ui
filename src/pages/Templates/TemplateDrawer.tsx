import {
    Button,
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
} from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import {
    Check as CheckIcon,
    Clipboard as ClipboardIcon,
    FileSimplePlus as FileSimplePlusIcon,
} from '@zappicon/react'
import { startTransition, useEffect, useState } from 'react'
import { useDebounce } from 'use-debounce'
import { useCatalog, useParsedCommand, useSortedOptions } from '../../../lib/catalog'
import { formatErrorMessage, reportError } from '../../../lib/errors'
import { operationOf } from '../../../lib/operations'
import { hasTemplatePaths } from '../../../lib/rclone/templatePaths'
import { message, platform } from '../../../lib/shell'
import { saveTemplate, type Template, type TemplateTag, tagNames } from '../../../lib/templates'
import Alert from '../../components/Alert'
import { drawerContentClass, SheetHeader } from '../../components/list/drawer'
import { toneButton } from '../../components/look/buttons'
import { IconTile } from '../../components/look/IconTile'
import { Panel } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { OptionsSection } from '../../components/operation/OptionsAccordion'
import { invalidJsonText } from '../../components/operation/optionGroups'
import { useOptionGroups } from '../../components/operation/useOptionGroups'
import { useOptionItems } from '../../components/operation/useOptionItems'
import {
    bareField,
    MultiPathField,
    PathField,
    RouteLink,
    RoutePanel,
    RouteRow,
} from '../../components/PathFinder'
import { toastWarning } from '../../components/toast'
import { useUnsavedChanges } from '../../components/unsaved'
import { WINDOWS } from '../../routes'
import {
    keptOf,
    seedTemplate,
    TEMPLATE_GROUPS,
    type TemplateOptions,
    templateGroups,
} from './templateOptions'

/** The values that an add-template link (rclone://add-template?cmd=…) fills into the drawer. */
export interface AddTemplatePayload {
    cmd?: string
    name?: string
}

type Tag = TemplateTag

const TAGS: { key: Tag; label: string }[] = (
    ['copy', 'move', 'sync', 'bisync', 'delete', 'purge', 'mount', 'serve'] as const
).map((key) => ({ key, label: WINDOWS[key].title }))

function pathsOf(sources: string[], destination: string): NonNullable<Template['paths']> {
    return {
        sources: sources.filter((source) => source.trim() !== ''),
        destination: destination.trim(),
    }
}

function notImported(skipped: readonly { flag: string; reason: string }[]): string {
    const flags = skipped.map((skip) => `${skip.flag} (${skip.reason})`).join(', ')
    return t({
        message: `Not imported: ${flags}`,
        comment: 'Under a pasted command: its flags that no group takes, each with why.',
    })
}

function alsoKept(names: readonly string[]): string {
    const options = names.join(', ')
    return t`Also kept from this template: ${options} (no group here offers them).`
}

function leftOut(names: readonly string[]): string {
    const options = names.join(', ')
    return t({
        message: `This template leaves out these app defaults: ${options}. Set one in a group to use it again.`,
        comment:
            'Options such as transfers, which a page saved as removed. The app runs this template without its default value for them.',
    })
}

/** What the drawer holds, to tell whether it changed. */
function snapshotOf(
    name: string,
    tags: Tag[],
    texts: readonly string[],
    importString: string,
    sources: string[],
    destination: string
) {
    return JSON.stringify({
        name,
        tags,
        texts,
        importString,
        paths: pathsOf(sources, destination),
    })
}

// The groups start as empty objects, with no defaults under them.
const EMPTY_SNAPSHOT = snapshotOf(
    '',
    [],
    TEMPLATE_GROUPS.map(() => JSON.stringify({}, null, 2)),
    '',
    [],
    ''
)

/**
 * Adds a template, or edits `template` when one is given. A new template can start from a
 * command line, which the user types or pastes, or which an add-template link passes in
 * `initialValues`.
 */
export default function TemplateDrawer({
    isOpen,
    onClose,
    template,
    initialValues,
    onDuplicated,
}: {
    isOpen: boolean
    onClose: () => void
    template?: Template
    /** Opens the copy that DUPLICATE saved. */
    onDuplicated?: (copy: Template) => void
    // Values from a deep link (rclone://add-template?cmd=…). Each link passes a new object, so
    // the same link opened twice still fills the drawer again.
    initialValues?: AddTemplatePayload | null
}) {
    const editing = !!template

    const [importString, setImportString] = useState('')
    const [debouncedImportString] = useDebounce(importString, 500)
    const [importedCount, setImportedCount] = useState<null | number>(null)

    const [name, setName] = useState(template?.name ?? '')
    const [tags, setTags] = useState<Tag[]>(template ? tagNames(template.tags) : [])
    const [sources, setSources] = useState<string[]>(template?.paths?.sources ?? [])
    const [destination, setDestination] = useState(template?.paths?.destination ?? '')

    // A template holds only the user's own options, so the groups start without defaults, and
    // what they send is what their texts hold.
    const optionState = useOptionGroups({ groups: TEMPLATE_GROUPS })
    const { groups, jsonError, replace, getMergedOptions, resetJson } = optionState
    const texts = TEMPLATE_GROUPS.map((key) => groups[key].jsonString)
    const optionItems = useOptionItems(optionState)
    // Options that the template sets but no group's editor shows, such as an option the drawer
    // doesn't offer, or an app default that it leaves out (a null). A save keeps them (keptOf).
    const [rest, setRest] = useState<TemplateOptions>({})
    const restNames = Object.keys(rest)
    const keptNames = restNames.filter((name) => rest[name] !== null)
    const leftOutNames = restNames.filter((name) => rest[name] === null)

    useEffect(() => {
        if (editing || !isOpen || !initialValues) return
        setImportString(initialValues.cmd ?? '')
        setName(initialValues.name ?? '')
    }, [editing, isOpen, initialValues])

    // When editing, the texts are filled once, when the core has sorted the template's options
    // into the catalog's groups. A later change to the template (a refetch, or a save from
    // another window) must not wipe what is being edited. Until the texts are filled they are
    // empty, and a save would write the template with no options, so saving waits until then.
    const sorted = useSortedOptions(editing ? template?.options : undefined)
    const [seeded, setSeeded] = useState(!editing)
    // The editors need rclone's options from the catalog, and an edited template needs its
    // options sorted. A failure of either shows the alert, with its retry.
    const catalog = useCatalog()
    const failed = catalog.isError ? catalog : sorted.isError ? sorted : undefined
    useEffect(() => {
        if (seeded || !template || !sorted.data) return

        const seed = seedTemplate(template.options, sorted.data)
        startTransition(() => {
            replace(seed.groups)
            setRest(seed.rest)
            setSeeded(true)
        })
    }, [seeded, template, sorted.data, replace])

    // The drawer holds changes when it differs from what it started with: the template once its
    // texts are filled, or an empty form when adding. Closing the drawer or the window asks
    // first.
    const snapshot = snapshotOf(name, tags, texts, importString, sources, destination)
    const [baseline, setBaseline] = useState<string | null>(editing ? null : EMPTY_SNAPSHOT)
    useEffect(() => {
        if (seeded && baseline === null) setBaseline(snapshot)
    }, [seeded, baseline, snapshot])
    const edited = baseline !== null && snapshot !== baseline
    const unsaved = useUnsavedChanges(isOpen && edited)
    const requestClose = async () => {
        if (await unsaved.confirm()) onClose()
    }

    // When adding, the core parses the command with rclone's own flags and sorts the options
    // into the groups whose texts the editors show.
    const parsed = useParsedCommand(editing ? '' : debouncedImportString)
    const skipped = parsed.data?.skipped ?? []

    useEffect(() => {
        if (!parsed.data) return
        const imported = parsed.data.groups
        replace(templateGroups(imported))

        const count = Object.values(imported).reduce((n, g) => n + Object.keys(g).length, 0)
        if (!count) {
            return
        }

        setImportedCount(count)
        setTimeout(() => {
            setImportedCount(null)
        }, 4500)
    }, [parsed.data, replace])

    const saveMutation = useMutation({
        mutationFn: async () => {
            // Throw rather than return, because onSuccess would close the drawer and lose what
            // was typed.
            if (!name) {
                throw new Error(t`Please enter a name for the template`)
            }
            if (!seeded) {
                throw new Error(t`The template's options haven't loaded yet`)
            }
            if (jsonError) {
                // The drawer has no Remotes section, so the invalid text is in one of its groups.
                // The message is the one that an operation page shows for that group.
                throw new Error(invalidJsonText(jsonError))
            }

            const paths = pathsOf(sources, destination)
            const merged = getMergedOptions()
            await saveTemplate({
                id: template?.id ?? crypto.randomUUID(),
                ...template,
                name,
                tags: tags.map(operationOf),
                options: { ...keptOf(rest, merged), ...merged },
                // Saved only when one of the fields is filled.
                paths: hasTemplatePaths(paths) ? paths : null,
            })
        },
        onSuccess: () => {
            unsaved.forget()
            onClose()
            if (editing) {
                setBaseline(snapshot)
                return
            }
            // The command must be cleared too. Otherwise, importing the same command again would
            // return the cached ParseCommand result (the same `data` object), and the effect that
            // fills the texts would not run again on the reset texts.
            setImportString('')
            setImportedCount(null)
            setName('')
            setTags([])
            setSources([])
            setDestination('')
            resetJson()
        },
        onError: async (error) => {
            await message(
                formatErrorMessage(error, t`Error saving template. Please check your options.`),
                {
                    title: t({ message: 'Error', comment: 'The title of an error dialog.' }),
                    kind: 'error',
                }
            )
            console.error(error)
        },
    })

    // Saves the template as it is saved now under a new id, then opens the copy. Edits that
    // aren't saved yet would not be in the copy, so they must be saved first.
    const duplicateMutation = useMutation({
        mutationFn: async () => {
            if (!template) throw new Error(t`Only a saved template can be duplicated.`)
            const name = template.name
            return saveTemplate({
                id: crypto.randomUUID(),
                name: t({
                    message: `${name} copy`,
                    comment: 'The name of a duplicated template: "Backup copy".',
                }),
                tags: template.tags,
                options: template.options,
                paths: template.paths,
            })
        },
        onSuccess: (copy) => onDuplicated?.(copy),
        onError: (error) =>
            reportError(error, {
                title: t`Template not duplicated`,
                fallback: t`The template could not be duplicated`,
                log: ['[TemplateDrawer] could not duplicate', template?.id],
            }),
    })
    const duplicate = () => {
        if (edited) {
            toastWarning(
                t`Save your changes first`,
                t`Duplicate copies the template as it is saved.`
            )
            return
        }
        duplicateMutation.mutate()
    }

    // The drawer has the look of the template's first operation, as its card does.
    const first = tags[0]
    const look = first ? WINDOWS[first] : WINDOWS.templates

    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={requestClose}
            hideCloseButton={true}
        >
            <DrawerContent className={drawerContentClass(platform() === 'macos')}>
                {(close) => (
                    <>
                        <DrawerHeader className="px-6 pt-5 pb-4">
                            <div className="w-full max-w-3xl mx-auto">
                                <SheetHeader
                                    look={look}
                                    title={
                                        editing
                                            ? template.name || t`Edit template`
                                            : t`New template`
                                    }
                                    description={
                                        editing
                                            ? t`Change its operations, paths and options.`
                                            : t`Start from an rclone command, or fill in the fields.`
                                    }
                                />
                            </div>
                        </DrawerHeader>
                        <DrawerBody id="template-drawer-body" className="px-6 py-0">
                            <ScrollShadow id="scroll-shadow" size={30}>
                                <div className="flex flex-col w-full max-w-3xl gap-6 pt-2 pb-6 mx-auto">
                                    {/* When editing, the texts stay empty until the options
                                        load, so saving waits for them. */}
                                    {failed && (!editing || !seeded) && (
                                        <Alert
                                            color="danger"
                                            variant="faded"
                                            title={t`Couldn't load rclone's options`}
                                            endContent={
                                                <Button
                                                    size="sm"
                                                    variant="flat"
                                                    color="danger"
                                                    isLoading={failed.isFetching}
                                                    onPress={() => failed.refetch()}
                                                    data-focus-visible="false"
                                                >
                                                    <Trans>Retry</Trans>
                                                </Button>
                                            }
                                        >
                                            <div className="flex flex-col gap-1">
                                                <span>{formatErrorMessage(failed.error)}</span>
                                                {editing && (
                                                    <span>
                                                        <Trans>
                                                            Saving is off until they load, so this
                                                            template keeps its options.
                                                        </Trans>
                                                    </span>
                                                )}
                                            </div>
                                        </Alert>
                                    )}

                                    {!editing && (
                                        <section className="flex flex-col gap-2.5">
                                            <SectionTitle
                                                title={t`Start from a command`}
                                                description={t`Paste an rclone command to use it as a starting point.`}
                                                className="px-1"
                                            />
                                            <Panel className="p-1.5">
                                                <Input
                                                    label={t({
                                                        message: 'Command',
                                                        comment:
                                                            'A field for an rclone command line.',
                                                    })}
                                                    placeholder="rclone copy --vfs-cache-mode writes ..."
                                                    value={importString}
                                                    onValueChange={(value) =>
                                                        setImportString(value)
                                                    }
                                                    classNames={{
                                                        ...bareField(!!parsed.error),
                                                        input: 'font-mono text-small',
                                                    }}
                                                    data-focus-visible="false"
                                                    autoComplete="off"
                                                    autoCorrect="off"
                                                    autoCapitalize="off"
                                                    spellCheck="false"
                                                    isInvalid={!!parsed.error}
                                                    errorMessage={
                                                        parsed.error
                                                            ? formatErrorMessage(parsed.error)
                                                            : undefined
                                                    }
                                                    description={
                                                        skipped.length > 0
                                                            ? notImported(skipped)
                                                            : undefined
                                                    }
                                                    endContent={
                                                        parsed.isLoading ? (
                                                            <Spinner size="sm" color="current" />
                                                        ) : importedCount === null ? (
                                                            <Button
                                                                variant="flat"
                                                                size="sm"
                                                                startContent={
                                                                    <ClipboardIcon className="size-4" />
                                                                }
                                                                onPress={() => {
                                                                    setTimeout(() => {
                                                                        // Rejects when the paste prompt is dismissed.
                                                                        navigator.clipboard
                                                                            .readText()
                                                                            .then((text) => {
                                                                                setImportString(
                                                                                    text
                                                                                )
                                                                            })
                                                                            .catch(() => {})
                                                                    }, 10)
                                                                }}
                                                            >
                                                                <Trans comment="Button: pastes a command from the clipboard.">
                                                                    Paste
                                                                </Trans>
                                                            </Button>
                                                        ) : (
                                                            <p className="flex items-center gap-1.5 pr-1 text-sm font-medium text-success-600 dark:text-success shrink-0">
                                                                <CheckIcon className="size-4" />
                                                                {plural(importedCount, {
                                                                    one: '# flag imported',
                                                                    other: '# flags imported',
                                                                })}
                                                            </p>
                                                        )
                                                    }
                                                />
                                            </Panel>
                                        </section>
                                    )}

                                    <section className="flex flex-col gap-2.5">
                                        <SectionTitle
                                            title={t({
                                                message: 'Template',
                                                comment:
                                                    'A noun: a saved set of paths and options.',
                                            })}
                                            className="px-1"
                                        />
                                        <Panel className="flex flex-col p-1.5">
                                            <Input
                                                label={t({
                                                    message: 'Name',
                                                    comment: "A field for the template's name.",
                                                })}
                                                placeholder={t({
                                                    message: 'My template',
                                                    comment: "An example of a template's name.",
                                                })}
                                                value={name}
                                                onValueChange={(value) => setName(value)}
                                                classNames={bareField()}
                                                data-focus-visible="false"
                                                autoComplete="off"
                                                autoCorrect="off"
                                                autoCapitalize="off"
                                                spellCheck="false"
                                                isClearable={true}
                                                onClear={() => setName('')}
                                            />
                                            <div className="h-px my-1 ml-3 bg-divider" />
                                            <Select
                                                isMultiline={false}
                                                items={TAGS}
                                                label={t({
                                                    message: 'Operations',
                                                    comment:
                                                        'The operations that a template can run as.',
                                                })}
                                                placeholder={t`What it runs as`}
                                                classNames={{
                                                    trigger: bareField().inputWrapper,
                                                    label: 'font-medium text-default-500',
                                                }}
                                                data-focus-visible="false"
                                                renderValue={(items) => (
                                                    <div className="flex flex-row flex-wrap w-full gap-x-3 gap-y-1">
                                                        {items.map((item) => {
                                                            const tagLook = item.data
                                                                ? WINDOWS[item.data.key]
                                                                : undefined
                                                            return (
                                                                <span
                                                                    key={item.key}
                                                                    className="flex items-center gap-1.5 font-medium"
                                                                >
                                                                    {tagLook && (
                                                                        <IconTile
                                                                            icon={tagLook.icon}
                                                                            tone={tagLook.tone}
                                                                            size="xs"
                                                                        />
                                                                    )}
                                                                    {item.data?.label}
                                                                </span>
                                                            )
                                                        })}
                                                    </div>
                                                )}
                                                selectedKeys={tags}
                                                selectionMode="multiple"
                                                onSelectionChange={(value) => {
                                                    // In the order they were picked: the first one gives the look.
                                                    setTags(
                                                        Array.from(value).flatMap((item) =>
                                                            TAGS.filter(
                                                                (tag) => tag.key === item.toString()
                                                            ).map((tag) => tag.key)
                                                        )
                                                    )
                                                }}
                                            >
                                                {(tagCategory) => {
                                                    const tagLook = WINDOWS[tagCategory.key]
                                                    return (
                                                        <SelectItem
                                                            variant="flat"
                                                            key={tagCategory.key}
                                                            textValue={tagCategory.label}
                                                            startContent={
                                                                <IconTile
                                                                    icon={tagLook.icon}
                                                                    tone={tagLook.tone}
                                                                    size="sm"
                                                                />
                                                            }
                                                        >
                                                            {tagCategory.label}
                                                        </SelectItem>
                                                    )
                                                }}
                                            </Select>
                                        </Panel>
                                    </section>

                                    <section className="flex flex-col gap-2.5">
                                        <SectionTitle
                                            title={t({
                                                message: 'Paths',
                                                comment: 'The paths that a template runs on.',
                                            })}
                                            description={t`The source and destination. Leave them empty to choose them at each run.`}
                                            className="px-1"
                                        />
                                        <RoutePanel tone={look.tone}>
                                            <RouteRow stop="from" tone={look.tone}>
                                                <MultiPathField
                                                    paths={sources}
                                                    setPaths={(paths) => setSources(paths ?? [])}
                                                    label={t`Sources`}
                                                    bare={true}
                                                />
                                            </RouteRow>
                                            <RouteLink tone={look.tone} />
                                            <RouteRow stop="to" tone={look.tone}>
                                                <PathField
                                                    path={destination}
                                                    setPath={setDestination}
                                                    label={t`Destination`}
                                                    placeholder={t`Enter a remote:path or local path`}
                                                    showFiles={false}
                                                    bare={true}
                                                />
                                            </RouteRow>
                                        </RoutePanel>
                                    </section>

                                    <OptionsSection items={optionItems} />

                                    {keptNames.length > 0 && (
                                        <p className="px-1 text-small text-default-500">
                                            {alsoKept(keptNames)}
                                        </p>
                                    )}
                                    {leftOutNames.length > 0 && (
                                        <p className="px-1 text-small text-default-500">
                                            {leftOut(leftOutNames)}
                                        </p>
                                    )}
                                </div>
                            </ScrollShadow>
                        </DrawerBody>
                        <DrawerFooter className="px-6">
                            <div className="flex w-full max-w-3xl gap-2 mx-auto">
                                {editing && (
                                    <Button
                                        variant="flat"
                                        className="mr-auto"
                                        startContent={<FileSimplePlusIcon className="size-4" />}
                                        isLoading={duplicateMutation.isPending}
                                        onPress={duplicate}
                                        data-focus-visible="false"
                                    >
                                        <Trans comment="Button: makes a copy of the template or the schedule.">
                                            Duplicate
                                        </Trans>
                                    </Button>
                                )}
                                <Button
                                    variant="light"
                                    className="ml-auto"
                                    onPress={() => {
                                        close()
                                    }}
                                    data-focus-visible="false"
                                >
                                    <Trans>Cancel</Trans>
                                </Button>
                                <Button
                                    color="primary"
                                    className={toneButton(WINDOWS.templates.tone)}
                                    isLoading={saveMutation.isPending}
                                    // When adding, wait until a pasted command has been parsed into
                                    // the texts. When editing, wait until its options are sorted.
                                    isDisabled={
                                        !seeded ||
                                        importString !== debouncedImportString ||
                                        parsed.isLoading
                                    }
                                    onPress={() => saveMutation.mutate()}
                                    data-focus-visible="false"
                                >
                                    {editing
                                        ? t`Save changes`
                                        : saveMutation.isPending
                                          ? t`Saving…`
                                          : t`Add template`}
                                </Button>
                            </div>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
