import {
    Button,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownSection,
    DropdownTrigger,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { LayerGroup as LayerGroupIcon, Plus as PlusIcon } from '@zappicon/react'
import { useMemo, useState } from 'react'
import type { Operations } from '../../../lib/core/types'
import { reportError } from '../../../lib/errors'
import { operationOf } from '../../../lib/operations'
import {
    applyTemplatePaths,
    hasTemplatePaths,
    savedPaths,
    type TemplatePaths,
} from '../../../lib/rclone/templatePaths'
import { message, prompt } from '../../../lib/shell'
import {
    saveTemplate,
    type Template,
    type TemplateTag,
    templateGroups,
    useTemplates,
} from '../../../lib/templates'
import type { FlagValue } from '../../../types/rclone'
import { TIP } from '../look/tip'

export interface PagePaths {
    get: () => TemplatePaths
    set: (paths: TemplatePaths) => void
}

const MERGE = t`Add to Existing`
const REPLACE = t`Replace All`

export default function TemplatesDropdown({
    onSelect,
    operation,
    serveType,
    isDisabled,
    getOptions,
    paths,
}: {
    onSelect: (groups: Operations.Groups, shouldMerge: boolean) => void
    operation: TemplateTag
    serveType?: string
    isDisabled: boolean
    getOptions: () => Record<string, FlagValue>
    paths?: PagePaths
}) {
    const allTemplates = useTemplates()

    const templates = useMemo(
        () => allTemplates.filter((template) => template.tags.some((tag) => tag === operation)),
        [allTemplates, operation]
    )

    const hasTemplates = useMemo(() => templates.length > 0, [templates])

    const keep = async () => {
        const result = await prompt({
            title: t`Add template`,
            message: t`Enter a name for the template`,
            default: '',
            sensitive: false,
        }).catch(async (e) => {
            console.error('[TemplatesDropdown] prompt_text error', e)
            await message(t`Failed to add the template.`, {
                title: t`Error`,
                kind: 'error',
            })
            return null
        })
        const inputtedName = result?.trim()
        if (!inputtedName || typeof inputtedName !== 'string') {
            return
        }

        const options = getOptions()
        const pagePaths = paths?.get()

        try {
            await saveTemplate({
                id: crypto.randomUUID(),
                name: inputtedName,
                tags: [operationOf(operation)],
                options,
                paths: savedPaths(pagePaths),
            })
        } catch (error) {
            await reportError(error, {
                title: t`Save as template`,
                fallback: t`The template could not be saved.`,
            })
        }
    }

    const apply = async (template: Template) => {
        const carriesPaths = hasTemplatePaths(template.paths)
        const pressed = await message(
            carriesPaths
                ? t`Would you like to merge the template with your existing flags and paths, or replace them?`
                : t`Would you like to merge the template with your existing flags, or replace all existing flags?`,
            {
                title: t`Apply Template`,
                kind: 'info',
                buttons: { ok: MERGE, extra: REPLACE, cancel: t`Cancel` },
            }
        )
        if (pressed !== MERGE && pressed !== REPLACE) {
            return
        }
        const merge = pressed === MERGE
        let applied: Awaited<ReturnType<typeof templateGroups>>
        try {
            applied = await templateGroups(template.id, operation, serveType)
        } catch (error) {
            await reportError(error, {
                title: t`Apply Template`,
                fallback: t`The template could not be applied.`,
            })
            return
        }
        if (paths && carriesPaths) {
            paths.set(applyTemplatePaths(paths.get(), template.paths, merge))
        }
        onSelect(applied.groups, merge)
    }

    const [asking, setAsking] = useState(false)

    return (
        <Dropdown
            shadow="none"
            placement="bottom-end"
            classNames={{
                content: 'border border-default-200 min-w-56',
            }}
        >
            {/* The tooltip goes around the trigger, never inside it: DropdownTrigger clones its
                one child, and would clone a Tooltip instead of the button. */}
            <Tooltip
                content={t`Apply a template, or save this page as one`}
                {...TIP}
                placement="bottom"
                delay={500}
                closeDelay={0}
                isDisabled={asking}
            >
                <div tabIndex={-1}>
                    <DropdownTrigger>
                        <Button
                            type="button"
                            variant="flat"
                            aria-label={t`Templates`}
                            startContent={<LayerGroupIcon className="size-[18px] shrink-0" />}
                            className="gap-1.5 px-3.5 font-medium text-default-700"
                            data-focus-visible="false"
                        >
                            <Trans>Templates</Trans>
                        </Button>
                    </DropdownTrigger>
                </div>
            </Tooltip>

            <DropdownMenu
                onAction={(key) => {
                    const template = templates.find((template) => template.id === key.toString())
                    if (key !== 'add' && !template) {
                        return
                    }
                    setTimeout(async () => {
                        setAsking(true)
                        try {
                            await (template ? apply(template) : keep())
                        } finally {
                            setAsking(false)
                        }
                    }, 100)
                }}
                color="primary"
                disabledKeys={
                    isDisabled ? ['add', ...templates.map((template) => template.id)] : []
                }
            >
                <DropdownSection
                    aria-label={t({
                        message: 'Save',
                        comment: 'The name of a menu section, which holds "Save as template".',
                    })}
                    showDivider={hasTemplates}
                    className={hasTemplates ? undefined : 'mb-0'}
                >
                    <DropdownItem
                        key="add"
                        color="success"
                        className="gap-2 text-success"
                        startContent={<PlusIcon className="size-4" />}
                        description={t`Keeps this page's paths and options`}
                    >
                        <Trans>Save as template</Trans>
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
