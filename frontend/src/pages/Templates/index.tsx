import { Button, Card, CardBody, CardHeader, Checkbox, Chip, Input, ScrollShadow, Tooltip, cn } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'

import {
    FileBoxIcon,
    LayoutTemplateIcon,
    MousePointerClickIcon,
    PlusIcon,
    SearchXIcon,
    StoreIcon,
    TrashIcon,
    XIcon,
} from 'lucide-react'
import { startTransition, useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { describeTemplatePaths } from '@/lib/rclone/templatePaths'
import { usePersistedStore } from '@/store'
import EmptyState from '@/components/EmptyState'
import TemplateAddDrawer, { type TemplatePrefill } from './TemplateAddDrawer'
import TemplateEditDrawer from './TemplateEditDrawer'
import { ask, saveAs, showLocation } from '@/dialog'
import { writeFile } from '@/lib/rclone/daemon-fs'
import { openUrl } from '@/navigate'

export default function Templates() {
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const templates = usePersistedStore((state) => state.templates)

    // The drawers are routes: `/templates/new` adds (`?cmd=&name=` says what to start from),
    // `/templates/<id>` edits; closing either is going back to the list.
    const { id } = useParams<{ id?: string }>()
    const isOpen = id === 'new'
    const onOpen = useCallback(() => navigate('/templates/new'), [navigate])
    const toList = useCallback(() => navigate('/templates'), [navigate])
    const addPayload = useMemo<TemplatePrefill | null>(() => {
        if (!isOpen) return null
        const cmd = searchParams.get('cmd')?.trim() || undefined
        const name = searchParams.get('name')?.trim() || undefined
        return cmd || name ? { cmd, name } : null
    }, [isOpen, searchParams])
    const selectedTemplate = useMemo(
        () => (id && id !== 'new' ? (templates.find((t) => t.id === id) ?? null) : null),
        [templates, id]
    )

    const [isSelecting, setIsSelecting] = useState(false)
    const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([])

    const [searchString, setSearchString] = useState('')

    const removeTemplatesMutation = useMutation({
        mutationFn: async (templateIds: string[]) => {
            const confirmed = await ask('Are you sure you want to remove these templates?', {
                kind: 'warning',
                title: 'Remove Templates',
            })

            if (!confirmed) {
                return
            }

            const newTemplates = templates.filter((template) => !templateIds.includes(template.id))

            usePersistedStore.setState({ templates: newTemplates })

            return true
        },
        onSuccess: (isDone) => {
            if (isDone) {
                setSelectedTemplateIds([])
                setIsSelecting(false)
            }
        },
    })

    const exportTemplatesMutation = useMutation({
        mutationFn: async (templateIds: string[]) => {
            const confirmed = await ask('Are you sure you want to export these templates?', {
                kind: 'warning',
                title: 'Export Templates',
            })

            if (!confirmed) {
                return
            }

            const selectedTemplates = templates
                .filter((template) => templateIds.includes(template.id))
                .map((template) => ({
                    name: template.name,
                    options: template.options,
                    ...(template.paths ? { paths: template.paths } : {}),
                    command: Object.entries(template.options)
                        .map(([key, value]) => {
                            const normalizedKey = key.replace(/_/g, '-')
                            if (value === true) return `--${normalizedKey}`
                            if (value === false) return `--${normalizedKey}=false`
                            return `--${normalizedKey} ${value}`
                        })
                        .join(' '),
                }))

            const path = await saveAs({
                defaultPath: `templates-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
            })

            if (!path) {
                return
            }

            await writeFile(path, JSON.stringify(selectedTemplates, null, 2))

            const shouldReveal = await ask(
                'Templates exported successfully.\n\nOpen containing folder?',
                {
                    title: 'Success',
                    kind: 'info',
                    okLabel: 'Open Folder',
                    cancelLabel: 'Cancel',
                }
            )

            if (shouldReveal) {
                await showLocation(path, 'File location')
            }

            return true
        },
        onSuccess: (isDone) => {
            if (isDone) {
                setSelectedTemplateIds([])
                setIsSelecting(false)
            }
        },
    })

    const filteredTemplates = useMemo(
        () =>
            templates.filter((template) =>
                template.name.toLowerCase().includes(searchString.toLowerCase())
            ),
        [templates, searchString]
    )

    return (
        <div className={cn('flex flex-col h-full')}>
            {/* Nothing to search or select until the first template; the empty state adds it. */}
            {templates.length > 0 && (
                <div className="flex flex-row items-center justify-between w-full px-6 py-4">
                    <Input
                        placeholder="Search Templates"
                        className="max-w-xs"
                        onClear={() => setSearchString('')}
                        isClearable={true}
                        onValueChange={setSearchString}
                        spellCheck="false"
                        autoCorrect="false"
                        autoCapitalize="false"
                        autoComplete="false"
                    />

                    <div className="flex flex-row items-center gap-2">
                        {!isSelecting && templates.length > 0 && (
                            <Button
                                startContent={<MousePointerClickIcon />}
                                className="gap-2 shrink-0"
                                onPress={() => setIsSelecting(true)}
                            >
                                SELECT
                            </Button>
                        )}
                        {isSelecting && (
                            <Button
                                className="gap-2 shrink-0"
                                color="primary"
                                onPress={() =>
                                    setSelectedTemplateIds(templates.map((template) => template.id))
                                }
                            >
                                SELECT ALL
                            </Button>
                        )}

                        <Button
                            color={isSelecting ? 'default' : 'primary'}
                            startContent={<PlusIcon />}
                            className="gap-1.5 shrink-0"
                            onPress={onOpen}
                        >
                            TEMPLATE
                        </Button>
                    </div>
                </div>
            )}

            {/* Main Content */}
            <ScrollShadow
                visibility="bottom"
                className="flex flex-col flex-1 w-full gap-6 px-6 pt-6 pb-10 overflow-y-auto bg-green-500/0"
            >
                {templates.length === 0 && (
                    <EmptyState
                        icon={LayoutTemplateIcon}
                        title="No templates yet"
                        description="Save a command's paths and options once, then reuse them from any window. The store button below has ready-made ones."
                        className="min-h-0 py-10"
                        actions={
                            <Button
                                color="primary"
                                startContent={<PlusIcon className="size-4" />}
                                onPress={onOpen}
                            >
                                New template
                            </Button>
                        }
                    />
                )}
                {templates.length > 0 && filteredTemplates.length === 0 && (
                    <EmptyState
                        icon={SearchXIcon}
                        title="No templates match"
                        description={`Nothing is named like “${searchString}”.`}
                        className="min-h-0 py-10"
                        actions={
                            <Button variant="flat" onPress={() => setSearchString('')}>
                                Clear search
                            </Button>
                        }
                    />
                )}
                <div className="grid grid-cols-3 gap-4 pb-2.5">
                    {filteredTemplates.map((template) => (
                        <Card
                            key={template.id}
                            classNames={{
                                base: 'shrink-0 bg-content2 border-divider border',
                            }}
                            radius="lg"
                            shadow="none"
                            isPressable={true}
                            isHoverable={true}
                            onPress={() => {
                                if (isSelecting) {
                                    if (selectedTemplateIds.includes(template.id)) {
                                        setSelectedTemplateIds(
                                            selectedTemplateIds.filter((id) => id !== template.id)
                                        )
                                    } else {
                                        setSelectedTemplateIds([
                                            ...selectedTemplateIds,
                                            template.id,
                                        ])
                                    }
                                    return
                                }
                                startTransition(() => {
                                    navigate(`/templates/${template.id}`)
                                })
                            }}
                        >
                            <CardHeader>
                                <div className="flex flex-row items-center ">
                                    {isSelecting && (
                                        <Checkbox
                                            isSelected={selectedTemplateIds.includes(template.id)}
                                            radius="full"
                                            onValueChange={(value) => {
                                                if (value) {
                                                    setSelectedTemplateIds([
                                                        ...selectedTemplateIds,
                                                        template.id,
                                                    ])
                                                } else {
                                                    setSelectedTemplateIds(
                                                        selectedTemplateIds.filter(
                                                            (id) => id !== template.id
                                                        )
                                                    )
                                                }
                                            }}
                                        />
                                    )}
                                    <p className="text-left line-clamp-1 text-large">
                                        {template.name}
                                    </p>
                                </div>
                            </CardHeader>
                            <CardBody>
                                <div className="flex flex-row items-center gap-2 pt-2 overflow-x-auto">
                                    {template.tags.map((tag) => (
                                        <Chip
                                            key={tag}
                                            variant="flat"
                                            color="primary"
                                            className="uppercase shrink-0"
                                        >
                                            {tag}
                                        </Chip>
                                    ))}
                                </div>
                                {describeTemplatePaths(template.paths) && (
                                    <p className="pt-2 font-mono truncate text-tiny text-foreground-500">
                                        {describeTemplatePaths(template.paths)}
                                    </p>
                                )}
                            </CardBody>
                        </Card>
                    ))}
                </div>
            </ScrollShadow>

            <div
                className={`absolute flex flex-row items-center justify-center w-full transition-transform-background bottom-5 duration-300 ease-out ${
                    isSelecting
                        ? 'translate-y-0 opacity-100 pointer-events-auto'
                        : 'translate-y-full opacity-0 pointer-events-none'
                }`}
            >
                <div className="flex flex-row items-center justify-between gap-2.5 px-3.5 bg-content/70 backdrop-blur-lg rounded-full py-2.5 border-divider border">
                    <Button
                        variant="flat"
                        color="success"
                        radius="full"
                        className="min-w-0 w-fit text-large tabular-nums"
                    >
                        {selectedTemplateIds.length}
                    </Button>
                    <Button
                        variant="flat"
                        color="primary"
                        radius="full"
                        className="gap-1.5"
                        startContent={<FileBoxIcon className="size-4" />}
                        onPress={() => exportTemplatesMutation.mutate(selectedTemplateIds)}
                    >
                        EXPORT
                    </Button>

                    <Button
                        variant="flat"
                        color="danger"
                        radius="full"
                        className="gap-1.5"
                        startContent={<TrashIcon className="size-4" />}
                        onPress={() => removeTemplatesMutation.mutate(selectedTemplateIds)}
                    >
                        REMOVE
                    </Button>
                    <Button
                        variant="flat"
                        color="default"
                        radius="full"
                        startContent={<XIcon className="size-4" />}
                        className="gap-1.5"
                        onPress={() =>
                            startTransition(() => {
                                setIsSelecting(false)
                                setSelectedTemplateIds([])
                            })
                        }
                    >
                        CANCEL
                    </Button>
                </div>
            </div>

            <Tooltip content="Templates Store" placement="left" color="foreground" size="lg">
                <Button
                    size="lg"
                    isIconOnly={true}
                    radius="full"
                    color="primary"
                    className="absolute bottom-6 right-6"
                    onPress={() => openUrl('https://rcloneui.com/templates')}
                    startContent={<StoreIcon size={28} />}
                />
            </Tooltip>

            <TemplateAddDrawer isOpen={isOpen} onClose={toList} initialValues={addPayload} />
            {selectedTemplate && (
                <TemplateEditDrawer
                    isOpen={true}
                    onClose={toList}
                    selectedTemplate={selectedTemplate}
                />
            )}
        </div>
    )
}
