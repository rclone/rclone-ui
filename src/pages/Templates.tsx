import {
    Button,
    Card,
    CardBody,
    CardHeader,
    Checkbox,
    Chip,
    Input,
    ScrollShadow,
    Tooltip,
    cn,
    useDisclosure,
} from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { listen } from '@tauri-apps/api/event'
import { ask, save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { platform } from '@tauri-apps/plugin-os'
import {
    FileBoxIcon,
    MousePointerClickIcon,
    PlusIcon,
    StoreIcon,
    TrashIcon,
    XIcon,
} from 'lucide-react'
import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ADD_TEMPLATE, type AddTemplatePayload } from '../../lib/events'
import { usePersistedStore } from '../../store/persisted'
import type { Template } from '../../types/template'
import TemplateAddDrawer from '../components/TemplateAddDrawer'
import TemplateEditDrawer from '../components/TemplateEditDrawer'

export default function Templates() {
    const [searchParams] = useSearchParams()

    const { isOpen, onOpen, onClose: onAddClose } = useDisclosure()
    // Deep-link prefill for the add drawer (rclone://add-template?cmd=…), see lib/deep.ts.
    const [addPayload, setAddPayload] = useState<AddTemplatePayload | null>(null)
    const handleAddClose = useCallback(() => {
        onAddClose()
        setAddPayload(null)
    }, [onAddClose])
    const {
        isOpen: isEditOpen,
        onOpen: onEditOpen,
        onOpenChange: onEditOpenChange,
    } = useDisclosure({
        onClose: () => {
            setTimeout(() => {
                startTransition(() => {
                    setSelectedTemplate(null)
                })
            }, 500)
        },
    })

    const templates = usePersistedStore((state) => state.templates)

    const [isSelecting, setIsSelecting] = useState(false)
    const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([])

    const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)

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
                    command: Object.entries(template.options)
                        .map(([key, value]) => {
                            const normalizedKey = key.replace(/_/g, '-')
                            if (value === true) return `--${normalizedKey}`
                            if (value === false) return `--${normalizedKey}=false`
                            return `--${normalizedKey} ${value}`
                        })
                        .join(' '),
                }))

            const path = await save({
                filters: [
                    {
                        name: 'JSON',
                        extensions: ['json'],
                    },
                ],
                defaultPath: `templates-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
            })

            if (!path) {
                return
            }

            await writeTextFile(path, JSON.stringify(selectedTemplates, null, 2))

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
                await revealItemInDir(path)
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

    // A deep link arriving while this window is already open can't change its URL, so the main
    // window forwards the payload over the event bus instead (lib/deep.ts).
    useEffect(() => {
        const unlisten = listen<AddTemplatePayload>(ADD_TEMPLATE, (event) => {
            const { cmd, name } = event.payload ?? {}
            setAddPayload(cmd || name ? { cmd, name } : null)
            onOpen()
        })
        return () => {
            unlisten.then((fn) => fn())
        }
    }, [onOpen])

    return (
        <div className={cn('flex flex-col h-screen', platform() === 'macos' && 'pt-7')}>
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
                    {!isSelecting && (
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

            {/* Main Content */}
            <ScrollShadow
                visibility="bottom"
                className="flex flex-col flex-1 w-full gap-6 px-6 pt-6 pb-10 overflow-y-auto bg-green-500/0"
            >
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
                                setTimeout(() => {
                                    if (isSelecting) {
                                        if (selectedTemplateIds.includes(template.id)) {
                                            setSelectedTemplateIds(
                                                selectedTemplateIds.filter(
                                                    (id) => id !== template.id
                                                )
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
                                        setSelectedTemplate(template)
                                        onEditOpen()
                                    })
                                }, 100)
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
                        onPress={() =>
                            setTimeout(() => {
                                exportTemplatesMutation.mutate(selectedTemplateIds)
                            }, 10)
                        }
                    >
                        EXPORT
                    </Button>

                    <Button
                        variant="flat"
                        color="danger"
                        radius="full"
                        className="gap-1.5"
                        startContent={<TrashIcon className="size-4" />}
                        onPress={() =>
                            setTimeout(() => {
                                removeTemplatesMutation.mutate(selectedTemplateIds)
                            }, 10)
                        }
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
                            setTimeout(() => {
                                startTransition(() => {
                                    setIsSelecting(false)
                                    setSelectedTemplateIds([])
                                })
                            }, 10)
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
                    onPress={() => {
                        setTimeout(async () => {
                            await openUrl('https://rcloneui.com/templates')
                        }, 100)
                    }}
                    startContent={<StoreIcon size={28} />}
                />
            </Tooltip>

            <TemplateAddDrawer
                isOpen={isOpen}
                onClose={handleAddClose}
                initialValues={addPayload}
            />
            {selectedTemplate && (
                <TemplateEditDrawer
                    isOpen={isEditOpen}
                    onClose={onEditOpenChange}
                    selectedTemplate={selectedTemplate}
                />
            )}
        </div>
    )
}
