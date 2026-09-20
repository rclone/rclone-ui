import {
    Button,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownSection,
    DropdownTrigger,
    Tooltip,
} from '@heroui/react'

import { FoldersIcon, PlusIcon } from 'lucide-react'
import { useMemo } from 'react'
import { groupByCategory } from '@/lib/flags'
import { useFlags } from '@/lib/hooks'
import { usePersistedStore } from '@/store'
import type { FlagValue } from '@/lib/rclone/types'
import { extraSourcesNote, hasTemplatePaths } from '@/lib/rclone/templatePaths'
import type { Template, TemplatePaths } from '@/lib/rclone/templatePaths'
import { ask, message, prompt } from '@/dialog'

export default function TemplatesDropdown({
    onSelect,
    operation,
    isDisabled,
    getOptions,
    getPaths,
}: {
    onSelect: (
        groupedOptions: ReturnType<typeof groupByCategory>,
        shouldMerge: boolean,
        paths?: TemplatePaths
    ) => void
    operation: Template['tags'][number]
    isDisabled: boolean
    getOptions: () => Record<string, FlagValue>
    /** What the page is set to run on, kept with the flags by SAVE AS TEMPLATE. */
    getPaths?: () => TemplatePaths | undefined
}) {
    const { allFlags } = useFlags()
    const allTemplates = usePersistedStore((state) => state.templates)

    const templates = useMemo(
        () => allTemplates.filter((template) => template.tags.includes(operation)),
        [allTemplates, operation]
    )

    const hasTemplates = useMemo(() => templates.length > 0, [templates])

    return (
        <Dropdown
            shadow="none"
            classNames={{
                content: 'border border-default-200',
            }}
        >
            {/* Named on hover like the bar's other icon buttons. The tooltip goes around the
                trigger, never inside it: DropdownTrigger clones its one child to make it the
                trigger, and a Tooltip in that place would be cloned instead of the button. */}
            <Tooltip content="Templates" placement="top" size="lg" color="foreground">
                {/* The tooltip makes its trigger focusable; the button already is, and two
                    tab stops for one control is one too many. */}
                <div tabIndex={-1}>
                    <DropdownTrigger>
                        <Button
                            onPress={() => {}}
                            size="lg"
                            type="button"
                            color="primary"
                            variant="shadow"
                            isIconOnly={true}
                            aria-label="Templates"
                        >
                            <FoldersIcon className="size-7" />
                        </Button>
                    </DropdownTrigger>
                </div>
            </Tooltip>

            <DropdownMenu
                onAction={async (key) => {
                    if (key === 'add') {
                        const result = await prompt({
                            title: 'Add Template',
                            message: 'Enter a name for the template',
                            default: '',
                            sensitive: false,
                        }).catch(async (e) => {
                            console.error('[TemplatesDropdown] prompt_text error', e)
                            await message('Failed to add the template.', {
                                title: 'Error',
                                kind: 'error',
                            })
                            return null
                        })
                        const inputtedName = result?.trim()
                        if (!inputtedName || typeof inputtedName !== 'string') {
                            return
                        }

                        usePersistedStore
                            .getState()
                            .addTemplate(inputtedName, operation, getOptions(), getPaths?.())
                        return
                    }
                    const template = templates.find((template) => template.id === key.toString())
                    if (!template || !allFlags) {
                        return
                    }

                    // One question for both halves of a template. The paths are only mentioned
                    // when it carries some, so a template of flags alone asks exactly what it
                    // always asked.
                    const carriesPaths = hasTemplatePaths(template.paths)
                    const note = extraSourcesNote(template.paths, operation)
                    const shouldMerge = await ask(
                        [
                            carriesPaths
                                ? 'Would you like to merge the template with your existing flags and paths, or replace them?'
                                : 'Would you like to merge the template with your existing flags, or replace all existing flags?',
                            note,
                        ]
                            .filter(Boolean)
                            .join('\n\n'),
                        {
                            title: 'Apply Template',
                            kind: 'info',
                            okLabel: 'Add to Existing',
                            cancelLabel: 'Replace All',
                        }
                    )
                    onSelect(
                        groupByCategory(template.options, allFlags),
                        shouldMerge,
                        template.paths
                    )
                }}
                color="primary"
                disabledKeys={isDisabled ? ['add'] : []}
            >
                <DropdownSection
                    showDivider={hasTemplates}
                    className={hasTemplates ? undefined : 'mb-0'}
                >
                    <DropdownItem
                        key="add"
                        color="success"
                        className="gap-1.5 text-success"
                        startContent={<PlusIcon className="size-4" />}
                    >
                        SAVE AS TEMPLATE
                    </DropdownItem>
                </DropdownSection>
                {
                    templates.map((template) => (
                        <DropdownItem className="group" key={template.id}>
                            {template.name}
                        </DropdownItem>
                    )) as unknown as ReturnType<typeof DropdownItem>
                }
            </DropdownMenu>
        </Dropdown>
    )
}
