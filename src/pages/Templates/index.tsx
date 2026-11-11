import {
    Button,
    Checkbox,
    cn,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Skeleton,
    Tab,
    Tabs,
    Tooltip,
    useDisclosure,
} from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    AngleDownSmall as AngleDownSmallIcon,
    ArrowUpRightSmall as ArrowUpRightIcon,
    CheckCircle as CheckCircleIcon,
    Clock as ClockIcon,
    FileSimpleArrowDown as FileSimpleArrowDownIcon,
    Play as PlayIcon,
    Plus as PlusIcon,
    Store as StoreIcon,
    Trash as TrashIcon,
} from '@zappicon/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { startTransition, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Operations } from '../../../lib/core/types'
import { coreError, formatErrorMessage, reportError } from '../../../lib/errors'
import { describeTemplatePaths, type TemplatePaths } from '../../../lib/rclone/templatePaths'
import { scheduleFromTemplate } from '../../../lib/schedules'
import {
    ask,
    currentWindow,
    message,
    openUrl,
    platform,
    revealPath,
    saveText,
} from '../../../lib/shell'
import {
    deleteTemplates,
    exportTemplates as exportFile,
    type Template,
    type TemplateTag,
    tagNames,
    templateGroups,
    useTemplateList,
} from '../../../lib/templates'
import { openHistory, runTemplate } from '../../../lib/transfers'
import EmptyState from '../../components/EmptyState'
import { LoadError, NoMatch, pageClass, SearchField, Steps } from '../../components/list/ListWindow'
import { matchAny } from '../../components/list/list'
import { toneButton } from '../../components/look/buttons'
import { IconTile } from '../../components/look/IconTile'
import { SURFACE, SURFACE_HOVER } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { TONE_RGB, TONE_TEXT } from '../../components/look/tones'
import { WindowHeader } from '../../components/look/WindowHeader'
import {
    confirmBisync,
    confirmDelete,
    confirmPurge,
    hasFilters,
} from '../../components/operation/confirmations'
import { isScheduleOperation, type ScheduleOperation } from '../../components/schedule/form'
import ScheduleDrawer from '../../components/schedule/ScheduleDrawer'
import { usePageQuery } from '../../route'
import { WINDOWS, type WindowLook } from '../../routes'
import TemplateDrawer, { type AddTemplatePayload } from './TemplateDrawer'

const GALLERY = 'https://rcloneui.com/templates'

const LOOK = WINDOWS.templates

const templateName = (template: Template) => [template.name]

export default function Templates() {
    const searchParams = usePageQuery()

    const { isOpen, onOpen, onClose: onAddClose } = useDisclosure()
    // Values that a deep link (rclone://add-template?cmd=…) fills into the add drawer. See
    // app/deeplink.
    const [addPayload, setAddPayload] = useState<AddTemplatePayload | null>(null)
    const handleAddClose = useCallback(() => {
        onAddClose()
        setAddPayload(null)
    }, [onAddClose])
    // When the edit drawer closes, its template is cleared after the drawer has slid out.
    // Opening a template before then cancels the timer. Otherwise the timer would unmount the
    // drawer that was just opened.
    const clearSelectedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
    const {
        isOpen: isEditOpen,
        onOpen: onEditOpen,
        onOpenChange: onEditOpenChange,
    } = useDisclosure({
        onOpen: () => clearTimeout(clearSelectedTimer.current),
        onClose: () => {
            clearTimeout(clearSelectedTimer.current)
            clearSelectedTimer.current = setTimeout(() => {
                startTransition(() => {
                    setSelectedTemplate(null)
                })
            }, 500)
        },
    })
    useEffect(() => () => clearTimeout(clearSelectedTimer.current), [])

    const { templates, tags, query: templatesQuery } = useTemplateList()

    const [selecting, setSelecting] = useState(false)
    const [selected, setSelected] = useState<string[]>([])
    const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)
    const [search, setSearch] = useState('')
    const [operation, setOperation] = useState<Group['key'] | 'all'>('all')

    // The Schedule drawer, with the form that a run of the template would start. The schedule
    // keeps a copy: editing the template later doesn't change it.
    const [scheduling, setScheduling] = useState<{
        isOpen: boolean
        key: number
        form: Operations.Form
    } | null>(null)
    const schedule = async (template: Template, tag: ScheduleOperation) => {
        try {
            const form = await scheduleFromTemplate(template.id, tag)
            setScheduling((was) => ({ isOpen: true, key: (was?.key ?? 0) + 1, form }))
        } catch (error) {
            await reportError(error, {
                title: t({
                    message: 'Schedule',
                    comment: 'The title of an error: scheduling failed.',
                }),
                fallback: t`The template could not be scheduled.`,
                log: ['[Templates] could not schedule', template.id, tag],
            })
        }
    }

    const openTemplate = useCallback(
        (template: Template) => {
            startTransition(() => {
                setSelectedTemplate(template)
                onEditOpen()
            })
        },
        [onEditOpen]
    )

    const doneSelecting = () => {
        setSelected([])
        setSelecting(false)
    }
    const toggle = (id: string) =>
        setSelected((was) => (was.includes(id) ? was.filter((x) => x !== id) : [...was, id]))

    const removeTemplates = async (ids: string[]) => {
        const names = templates
            .filter((template) => ids.includes(template.id))
            .map((template) => template.name)
        const count = names.length
        const [name] = names
        const list = names.join(', ')
        const deleteLabel = plural(count, { one: 'Delete template', other: 'Delete templates' })
        const sure = await ask(
            count === 1
                ? t`Delete ${name}? This can't be undone.`
                : plural(count, {
                      one: `Delete # template: ${list}? This can't be undone.`,
                      other: `Delete # templates: ${list}? This can't be undone.`,
                  }),
            {
                kind: 'warning',
                destructive: true,
                title: deleteLabel,
                okLabel: deleteLabel,
                cancelLabel: plural(count, { one: 'Keep it', other: 'Keep them' }),
            }
        )
        if (!sure) return
        try {
            await deleteTemplates(ids)
        } catch (error) {
            await reportError(error, {
                title: t`Templates not deleted`,
                fallback: t`The templates could not be deleted`,
                log: ['[Templates] could not delete', ids],
            })
            return
        }
        doneSelecting()
    }

    // Exports without asking first. The core gives the file's text, and the app writes it where
    // the user chose in the save dialog.
    const exportTemplates = async (ids: string[]) => {
        try {
            const text = await exportFile(ids)
            const path = await saveText(text, {
                filters: [{ DisplayName: 'JSON', Pattern: '*.json' }],
                defaultPath: `templates-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
            })
            if (!path) return
            doneSelecting()
            const shouldReveal = await ask(
                t`Templates exported successfully.\n\nOpen containing folder?`,
                {
                    title: t`Templates exported`,
                    kind: 'info',
                    okLabel: t`Open Folder`,
                    cancelLabel: t`Cancel`,
                }
            )
            if (shouldReveal) await revealPath(path)
        } catch (error) {
            await reportError(error, {
                title: t`Export Templates`,
                fallback: t`The templates could not be exported.`,
            })
        }
    }

    const shown = useMemo(() => matchAny(templates, search, templateName), [templates, search])

    useEffect(() => {
        const action = searchParams.get('action')
        if (action === 'add') {
            const cmd = searchParams.get('cmd')?.trim() || undefined
            const name = searchParams.get('name')?.trim() || undefined
            if (cmd || name) {
                setAddPayload({ cmd, name })
            }
            onOpen()
        }
    }, [searchParams, onOpen])

    // When a deep link arrives while this window is already open, the app sends the window the
    // link's route (window:route), and the add drawer opens with the link's fields.
    useEffect(
        () =>
            currentWindow.onRoute((route) => {
                const params = new URL(route, window.location.href).searchParams
                if (params.get('action') !== 'add') return
                const cmd = params.get('cmd') || undefined
                const name = params.get('name') || undefined
                setAddPayload(cmd || name ? { cmd, name } : null)
                onOpen()
            }),
        [onOpen]
    )

    const openGallery = () => {
        openUrl(GALLERY).catch((error: unknown) =>
            console.error('[Templates] could not open the gallery', error)
        )
    }

    const drawers = (
        <>
            <TemplateDrawer isOpen={isOpen} onClose={handleAddClose} initialValues={addPayload} />
            {selectedTemplate && (
                <TemplateDrawer
                    // One drawer per template, because a drawer fills its sections only once.
                    key={selectedTemplate.id}
                    isOpen={isEditOpen}
                    onClose={onEditOpenChange}
                    template={selectedTemplate}
                    onDuplicated={openTemplate}
                />
            )}
            {scheduling && (
                <ScheduleDrawer
                    key={scheduling.key}
                    isOpen={scheduling.isOpen}
                    onClose={() => setScheduling((was) => was && { ...was, isOpen: false })}
                    form={scheduling.form}
                />
            )}
        </>
    )

    const page = pageClass(platform() === 'macos')

    // Don't show a list that failed to load as empty.
    if (templatesQuery.isError) {
        return (
            <div className={page}>
                <LoadError
                    look={LOOK}
                    title={t`Couldn't load the templates`}
                    error={templatesQuery.error}
                    retrying={templatesQuery.isFetching}
                    onRetry={() => templatesQuery.refetch()}
                />
                {drawers}
            </div>
        )
    }

    if (templatesQuery.isLoading) {
        return (
            <div className={page}>
                <ListSkeleton />
                {drawers}
            </div>
        )
    }

    const newButton = (
        <Button
            color="primary"
            className={toneButton(LOOK.tone)}
            startContent={<PlusIcon className="size-4" />}
            onPress={onOpen}
        >
            <Trans>New template</Trans>
        </Button>
    )

    if (templates.length === 0) {
        return (
            <div className={page}>
                <EmptyState
                    icon={LOOK.icon}
                    tone={LOOK.tone}
                    title={t`No templates yet`}
                    description={t`Save a command's paths and options once, then run it again in one click. Browse the gallery for inspiration.`}
                    className="flex-1"
                    actions={
                        <>
                            {newButton}
                            <Button
                                variant="flat"
                                startContent={<StoreIcon className="size-4" />}
                                onPress={openGallery}
                            >
                                <Trans>Open the gallery</Trans>
                            </Button>
                        </>
                    }
                >
                    <Steps steps={STEPS} tone={LOOK.tone} />
                </EmptyState>
                {drawers}
            </div>
        )
    }

    const groups = groupByOperation(shown, tagNames(tags))
    const current = groups.some((g) => g.key === operation) ? operation : 'all'
    const searched = search.trim()
    const visible =
        current === 'all'
            ? groups.flatMap((g) => g.templates)
            : (groups.find((g) => g.key === current)?.templates ?? [])
    return (
        <div className={page}>
            <div className="relative flex flex-col gap-4 px-6 pt-5 pb-4 shrink-0">
                <WindowHeader
                    look={LOOK}
                    description={t`Saved paths and options, ready to run again or to schedule.`}
                    actions={newButton}
                />
                <div className="flex flex-wrap items-center gap-3 min-h-10">
                    <SearchField
                        label={t`Search templates`}
                        value={search}
                        onValueChange={setSearch}
                    />
                    {/* Select turns into Done in place, at the same width, so the header never
                        moves. */}
                    <Button
                        variant={selecting ? 'flat' : 'light'}
                        className="ml-auto min-w-24"
                        startContent={
                            selecting ? undefined : <CheckCircleIcon className="size-4" />
                        }
                        onPress={selecting ? doneSelecting : () => setSelecting(true)}
                    >
                        {selecting
                            ? t({ message: 'Done', comment: 'Button: stops picking templates.' })
                            : t({
                                  message: 'Select',
                                  comment: 'Button: starts picking templates.',
                              })}
                    </Button>
                </div>
                {groups.length > 1 && (
                    <Tabs
                        aria-label={t({
                            message: 'Operation',
                            comment: 'The tabs that show the templates of one operation.',
                        })}
                        size="sm"
                        radius="full"
                        selectedKey={current}
                        onSelectionChange={(key) => setOperation(key as Group['key'] | 'all')}
                        classNames={{ base: 'max-w-full', tab: 'h-8 px-3' }}
                    >
                        <Tab
                            key="all"
                            title={
                                <TabTitle
                                    label={t({
                                        message: 'All',
                                        context: 'Templates tab',
                                        comment: 'Every template.',
                                    })}
                                    count={shown.length}
                                />
                            }
                        />
                        {groups.map((g) => (
                            <Tab
                                key={g.key}
                                title={
                                    <TabTitle
                                        label={g.look.title}
                                        count={g.templates.length}
                                        look={g.look}
                                    />
                                }
                            />
                        ))}
                    </Tabs>
                )}
            </div>

            <div
                className={cn(
                    'flex flex-col flex-1 min-h-0 gap-10 px-6 pt-1 overflow-y-auto',
                    // Room for the selection bar, so the last cards can scroll out from under it.
                    selecting ? 'pb-28' : 'pb-10'
                )}
            >
                {visible.length === 0 ? (
                    <NoMatch
                        look={LOOK}
                        title={t`No templates match`}
                        description={t`No template is named like “${searched}”.`}
                        onClear={() => setSearch('')}
                    />
                ) : (
                    <ul
                        aria-label={LOOK.title}
                        className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]"
                    >
                        {visible.map((template) => (
                            <li key={template.id}>
                                <TemplateCard
                                    template={template}
                                    selecting={selecting}
                                    selected={selected.includes(template.id)}
                                    onToggle={() => toggle(template.id)}
                                    onOpen={() => openTemplate(template)}
                                    onSchedule={(tag) => schedule(template, tag)}
                                />
                            </li>
                        ))}
                    </ul>
                )}
                {/* The gallery's templates can't be picked, and the selection bar would cover it. */}
                {!selecting && <GallerySection onOpen={openGallery} />}
            </div>

            <SelectionBar
                isOpen={selecting}
                count={selected.length}
                allPicked={
                    visible.length > 0 &&
                    visible.every((template) => selected.includes(template.id))
                }
                onSelectAll={() => setSelected(visible.map((template) => template.id))}
                onSelectNone={() => setSelected([])}
                onExport={() => exportTemplates(selected)}
                onDelete={() => removeTemplates(selected)}
            />

            {drawers}
        </div>
    )
}

function SelectionBar({
    isOpen,
    count,
    allPicked,
    onSelectAll,
    onSelectNone,
    onExport,
    onDelete,
}: {
    isOpen: boolean
    count: number
    allPicked: boolean
    onSelectAll: () => void
    onSelectNone: () => void
    onExport: () => void
    onDelete: () => void
}) {
    const still = useReducedMotion()
    return (
        <AnimatePresence initial={false}>
            {isOpen && (
                <motion.div
                    role="toolbar"
                    aria-label={t`Picked templates`}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                    transition={
                        still ? { duration: 0 } : { type: 'spring', duration: 0.3, bounce: 0 }
                    }
                    className="absolute inset-x-0 bottom-0 z-40 px-6 pt-6 pb-4 pointer-events-none"
                >
                    {/* The list fades out under the bar, as under an operation page's. */}
                    <div
                        aria-hidden={true}
                        className="absolute inset-0 -z-10 bg-linear-to-t from-background from-40% to-transparent dark:from-[#121212]"
                    />
                    <div className="flex items-center w-full max-w-xl gap-2 p-2 mx-auto pointer-events-auto rounded-[22px] bg-white/[0.92] backdrop-blur-xl backdrop-saturate-150 shadow-[0_0_0_1px_rgb(0_0_0/0.07),0_10px_30px_-8px_rgb(0_0_0/0.22)] dark:bg-[#232326]/[0.92] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.09),0_10px_30px_-8px_rgb(0_0_0/0.9)]">
                        <span className="pl-3 pr-1 text-sm font-medium tabular-nums whitespace-nowrap">
                            {count === 0
                                ? t`Pick templates`
                                : plural(count, { one: '# selected', other: '# selected' })}
                        </span>
                        <Button
                            variant="light"
                            size="sm"
                            onPress={allPicked ? onSelectNone : onSelectAll}
                        >
                            {allPicked ? t`Select none` : t`Select all`}
                        </Button>
                        <div className="flex-1" />
                        <Button
                            variant="flat"
                            startContent={<FileSimpleArrowDownIcon className="size-4" />}
                            isDisabled={count === 0}
                            onPress={onExport}
                        >
                            <Trans comment="Button: exports the picked templates to a file.">
                                Export
                            </Trans>
                        </Button>
                        <Button
                            variant="flat"
                            color="danger"
                            startContent={<TrashIcon className="size-4" />}
                            isDisabled={count === 0}
                            onPress={onDelete}
                        >
                            <Trans comment="Button: deletes the picked templates.">Delete</Trans>
                        </Button>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}

const STEPS = [
    t`Paste an rclone command, or fill in the paths and options.`,
    t`Run it from its card, in one click.`,
    t`Or schedule it, to run at set times.`,
]

type Tag = TemplateTag

function lookOf(tag: Tag | undefined): WindowLook {
    return tag && tag in WINDOWS ? WINDOWS[tag] : LOOK
}

/** A group of the list: the templates whose first operation is `key`. */
interface Group {
    key: Tag | 'other'
    look: WindowLook
    templates: Template[]
}

/** The groups are in the order of `tags` (the core's list). Templates with no operation are last. */
function groupByOperation(templates: readonly Template[], tags: readonly Tag[]): Group[] {
    const groups: Group[] = tags.map((key) => ({ key, look: lookOf(key), templates: [] }))
    const other: Group = {
        key: 'other',
        look: {
            ...LOOK,
            title: t({
                message: 'Other',
                comment: 'A tab of the templates that run as no operation.',
            }),
        },
        templates: [],
    }
    for (const template of templates) {
        const group = groups.find((g) => g.key === template.tags[0]) ?? other
        group.templates.push(template)
    }
    return [...groups, other].filter((g) => g.templates.length > 0)
}

function TabTitle({ label, count, look }: { label: string; count: number; look?: WindowLook }) {
    return (
        <span className="flex items-center gap-1.5">
            {look && <IconTile icon={look.icon} tone={look.tone} size="xs" />}
            {label}
            <span className="tabular-nums opacity-60">{count}</span>
        </span>
    )
}

function GallerySection({ onOpen }: { onOpen: () => void }) {
    const id = useId()
    return (
        <section aria-labelledby={id} className="flex flex-col gap-3">
            <SectionTitle id={id} title={t`From the gallery`} className="px-1" />
            <div
                className={cn(
                    SURFACE,
                    'relative flex flex-wrap items-center gap-4 p-4 overflow-hidden'
                )}
            >
                <div
                    aria-hidden={true}
                    className="absolute inset-0 pointer-events-none"
                    style={{
                        background: `radial-gradient(60% 140% at 0% 0%, rgb(${TONE_RGB[LOOK.tone]} / 0.14), transparent 70%)`,
                    }}
                />
                <IconTile icon={StoreIcon} tone={LOOK.tone} size="xl" className="relative" />
                <div className="relative flex flex-col flex-1 gap-0.5 min-w-60">
                    <p className="font-semibold">
                        <Trans>Ready-made templates</Trans>
                    </p>
                    <p className="leading-snug text-small text-default-500 text-pretty">
                        <Trans>
                            Templates for common jobs, such as backing up photos or mirroring a
                            folder. Add one, and it shows up here.
                        </Trans>
                    </p>
                </div>
                <Button
                    variant="flat"
                    className="relative"
                    endContent={<ArrowUpRightIcon className="size-4" />}
                    onPress={onOpen}
                >
                    <Trans>Open the gallery</Trans>
                </Button>
            </div>
        </section>
    )
}

function ListSkeleton() {
    return (
        <div aria-busy={true} aria-label={t`Loading`} className="flex flex-col gap-5 px-6 pt-5">
            <div className="flex items-center gap-3.5">
                <Skeleton className="size-12 rounded-[14px]" />
                <div className="flex flex-col gap-2">
                    <Skeleton className="w-40 h-5 rounded-md" />
                    <Skeleton className="h-3.5 rounded-md w-72" />
                </div>
            </div>
            <Skeleton className="w-full h-10 max-w-sm rounded-xl" />
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
                {[0, 1, 2].map((i) => (
                    <div key={i} className={cn(SURFACE, 'flex flex-col gap-4 p-4 h-40')}>
                        <Skeleton className="size-9 rounded-[10px]" />
                        <div className="flex flex-col gap-2 mt-auto">
                            <Skeleton className="w-32 h-4 rounded-md" />
                            <Skeleton className="w-24 h-3 rounded-md" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}

function ScheduleButton({
    template,
    tags,
    onSchedule,
}: {
    template: Template
    tags: ScheduleOperation[]
    onSchedule: (tag: ScheduleOperation) => void
}) {
    const name = template.name
    const button = (
        <Button
            size="sm"
            variant="flat"
            isIconOnly={true}
            aria-label={t`Schedule ${name}`}
            onPress={tags.length === 1 ? () => onSchedule(tags[0]) : undefined}
            className="text-default-600"
        >
            <ClockIcon className="size-4" />
        </Button>
    )
    if (tags.length === 1) {
        return (
            <Tooltip
                content={t({ message: 'Schedule', comment: 'Button: schedules the template.' })}
                color="foreground"
                delay={300}
            >
                {button}
            </Tooltip>
        )
    }
    return (
        <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
            <DropdownTrigger>{button}</DropdownTrigger>
            <DropdownMenu
                aria-label={t`Schedule ${name} as`}
                onAction={(key) => onSchedule(key as ScheduleOperation)}
            >
                {tags.map((tag) => {
                    const look = lookOf(tag)
                    const label = scheduleLabel(tag)
                    return (
                        <DropdownItem
                            key={tag}
                            textValue={label}
                            startContent={<IconTile icon={look.icon} tone={look.tone} size="sm" />}
                        >
                            {label}
                        </DropdownItem>
                    )
                })}
            </DropdownMenu>
        </Dropdown>
    )
}

function scheduleLabel(tag: ScheduleOperation): string {
    switch (tag) {
        case 'copy':
            return t`Schedule Copy`
        case 'move':
            return t`Schedule Move`
        case 'sync':
            return t`Schedule Sync`
        case 'bisync':
            return t`Schedule Bisync`
        case 'delete':
            return t`Schedule Delete`
        default:
            return t`Schedule Purge`
    }
}

function runLabels(tag: Tag, name: string): { item: string; aria: string } {
    switch (tag) {
        case 'copy':
            return { item: t`Run as Copy`, aria: t`Run ${name} as Copy` }
        case 'move':
            return { item: t`Run as Move`, aria: t`Run ${name} as Move` }
        case 'sync':
            return { item: t`Run as Sync`, aria: t`Run ${name} as Sync` }
        case 'bisync':
            return { item: t`Run as Bisync`, aria: t`Run ${name} as Bisync` }
        case 'delete':
            return { item: t`Run as Delete`, aria: t`Run ${name} as Delete` }
        case 'purge':
            return { item: t`Run as Purge`, aria: t`Run ${name} as Purge` }
        case 'mount':
            return { item: t`Run as Mount`, aria: t`Run ${name} as Mount` }
        default:
            return { item: t`Run as Serve`, aria: t`Run ${name} as Serve` }
    }
}

function TemplateCard({
    template,
    selecting,
    selected,
    onToggle,
    onOpen,
    onSchedule,
}: {
    template: Template
    selecting: boolean
    selected: boolean
    onToggle: () => void
    onOpen: () => void
    onSchedule: (tag: ScheduleOperation) => void
}) {
    const name = template.name
    const tags = tagNames(template.tags)
    const look = lookOf(tags[0])
    const options = Object.keys(template.options).length
    const paths = describeTemplatePaths(template.paths)
    // The tags that the card can run, and schedule. Mount and Serve are applied in their forms.
    const runs = paths ? tags.filter(isScheduleOperation) : []
    const also = tags.slice(1)

    return (
        <div
            className={cn(
                SURFACE,
                SURFACE_HOVER,
                'relative isolate flex flex-col justify-between gap-6 h-full p-4 overflow-hidden',
                'transition-[translate,scale,box-shadow] duration-150 ease-out hover:-translate-y-0.5 has-[[data-card]:active]:scale-[0.98]',
                'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
                selected && 'ring-2 ring-primary'
            )}
        >
            <div
                aria-hidden={true}
                className="absolute inset-0 pointer-events-none -z-10"
                style={{
                    background: `radial-gradient(90% 70% at 0% 0%, rgb(${TONE_RGB[look.tone]} / 0.12), transparent 70%)`,
                }}
            />
            <div className="flex items-start justify-between gap-2">
                <IconTile icon={look.icon} tone={look.tone} size="lg" />
                {selecting ? (
                    <Checkbox
                        aria-label={t({
                            message: `Select ${name}`,
                            comment: 'A checkbox that picks the template.',
                        })}
                        isSelected={selected}
                        onValueChange={onToggle}
                        radius="full"
                        className="relative z-10 m-0"
                    />
                ) : (
                    runs.length > 0 && (
                        <div className="relative z-10 flex flex-wrap items-start justify-end gap-1.5">
                            <RunButtons template={template} tags={runs} />
                            <ScheduleButton
                                template={template}
                                tags={runs}
                                onSchedule={onSchedule}
                            />
                        </div>
                    )
                )}
            </div>

            <div className="flex flex-col min-w-0 gap-1">
                {/* The name covers the card: it opens the template, or picks it while selecting. */}
                <button
                    type="button"
                    data-card={true}
                    onClick={selecting ? onToggle : onOpen}
                    className="font-semibold leading-snug text-left truncate outline-none cursor-pointer text-[15px] after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-primary"
                >
                    {template.name}
                </button>
                <p className="flex flex-wrap items-center text-xs gap-x-1.5 gap-y-1 text-default-500 tabular-nums">
                    <span>
                        {options > 0
                            ? plural(options, { one: '# option', other: '# options' })
                            : t`No options`}
                    </span>
                    {also.map((tag) => (
                        <span key={tag} className="flex items-center gap-1.5">
                            <span aria-hidden={true} className="text-default-300">
                                ·
                            </span>
                            <span className={cn('font-medium', TONE_TEXT[lookOf(tag).tone])}>
                                {lookOf(tag).title}
                            </span>
                        </span>
                    ))}
                </p>
                {paths ? (
                    <Tooltip
                        content={<PathsList paths={template.paths} />}
                        placement="bottom-start"
                        delay={400}
                    >
                        <p className="relative z-10 max-w-full font-mono truncate text-tiny text-default-400 w-fit">
                            {paths}
                        </p>
                    </Tooltip>
                ) : (
                    <p className="text-tiny text-default-400">
                        <Trans>No paths</Trans>
                    </p>
                )}
            </div>
        </div>
    )
}

function PathsList({ paths }: { paths: TemplatePaths | null }) {
    return (
        <div className="flex flex-col gap-1 py-1 font-mono text-tiny max-w-[480px]">
            {paths?.sources?.map((source) => (
                <span key={source} className="break-all">
                    {source}
                </span>
            ))}
            {paths?.destination && <span className="break-all">→ {paths.destination}</span>}
        </div>
    )
}

function RunButtons({ template, tags }: { template: Template; tags: Tag[] }) {
    const [pending, setPending] = useState(false)
    const name = template.name

    // A run asks what its page asks before it starts. A template has no bisync switches. A
    // delete's filters are the ones that the core puts in its form.
    const confirmed = async (tag: Tag): Promise<boolean> => {
        const sources = template.paths?.sources ?? []
        if (tag === 'delete') {
            const { groups } = await templateGroups(template.id, 'delete')
            return confirmDelete(sources, hasFilters(groups.filter, groups.metadata))
        }
        if (tag === 'purge') return confirmPurge(sources)
        if (tag === 'bisync') {
            return confirmBisync(sources[0] ?? '', template.paths?.destination ?? '')
        }
        return true
    }

    const run = async (tag: Tag) => {
        if (pending) return
        setPending(true)
        try {
            if (!(await confirmed(tag))) return
            const id = await runTemplate(template.id, tag)
            await openHistory(id)
        } catch (failure) {
            // The transfer was recorded before it failed, so it is listed with the others.
            const recorded = coreError(failure)?.transfer?.id
            if (recorded) {
                const show = t`Show transfer`
                const pressed = await message(
                    formatErrorMessage(failure, t`Failed to run the template`),
                    {
                        title: t`Run Template`,
                        kind: 'error',
                        buttons: { ok: show, cancel: t`Close` },
                    }
                )
                if (pressed === show) await openHistory(recorded)
                return
            }
            await reportError(failure, {
                title: t`Run Template`,
                fallback: t`Failed to run the template`,
                log: ['[Templates] could not run', template.id, tag],
            })
        } finally {
            setPending(false)
        }
    }

    const play = (tag: Tag) => (
        <PlayIcon variant="filled" className={cn('size-3.5', TONE_TEXT[lookOf(tag).tone])} />
    )
    if (tags.length === 1) {
        const [tag] = tags
        return (
            <Button
                size="sm"
                variant="flat"
                isDisabled={pending}
                startContent={play(tag)}
                onPress={() => run(tag)}
                aria-label={runLabels(tag, name).aria}
                className="font-medium"
            >
                <Trans comment="Button: runs the template.">Run</Trans>
            </Button>
        )
    }
    // With several operations, Run asks which one.
    return (
        <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
            <DropdownTrigger>
                <Button
                    size="sm"
                    variant="flat"
                    isDisabled={pending}
                    startContent={play(tags[0])}
                    endContent={<AngleDownSmallIcon className="-mr-1 size-4 text-default-500" />}
                    aria-label={t`Run ${name}`}
                    className="font-medium"
                >
                    <Trans comment="Button: runs the template.">Run</Trans>
                </Button>
            </DropdownTrigger>
            <DropdownMenu aria-label={t`Run ${name} as`} onAction={(key) => run(key as Tag)}>
                {tags.map((tag) => {
                    const look = lookOf(tag)
                    const labels = runLabels(tag, name)
                    return (
                        <DropdownItem
                            key={tag}
                            textValue={labels.item}
                            aria-label={labels.aria}
                            startContent={<IconTile icon={look.icon} tone={look.tone} size="sm" />}
                        >
                            {labels.item}
                        </DropdownItem>
                    )
                })}
            </DropdownMenu>
        </Dropdown>
    )
}
