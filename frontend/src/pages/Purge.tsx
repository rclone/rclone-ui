import { useMemo, useState } from 'react'
import { useOperationPreset } from '@/components/operation/useOperationPreset'
import { useOperationSubmission } from '@/components/operation/useOperationSubmission'
import { getOptionsSubtitle } from '@/lib/flags'
import { useFlags } from '@/lib/hooks'
import { applyTemplatePaths } from '@/lib/rclone/templatePaths'
import { startPurge } from '@/lib/rclone/start'
import { RCLONE_CONFIG_DEFAULTS } from '@/lib/rclone/constants'
import OperationWindowContent from '@/components/OperationWindowContent'
import OperationWindowFooter from '@/components/OperationWindowFooter'
import OptionsSection from '@/components/OptionsSection'
import { MultiPathField } from '@/components/PathFinder'
import type { AllowedKey } from '@/components/navigator/types'
import { CronSection } from '@/components/CronEditor'
import OperationFooter from '@/components/operation/OperationFooter'
import OptionsAccordion, {
    type OptionsAccordionItemDef,
} from '@/components/operation/OptionsAccordion'
import { useOptionGroups } from '@/components/operation/useOptionGroups'

const PATH_ALLOWED_KEYS: AllowedKey[] = ['REMOTES', 'FAVORITES']

const DEFAULT_EXPANDED_KEYS = ['config']

export default function Purge() {
    const { preset, onStarted } = useOperationPreset('purge')
    const { globalFlags, configFlags } = useFlags()

    const [sources, setSources] = useState<string[] | undefined>(preset?.args.sources)

    const [cronExpression, setCronExpression] = useState<string | null>(preset?.cron ?? null)

    const {
        jsonError,
        setJsonError,
        groups: optionGroups,
        applyTemplate,
        getMergedOptions,
        resetJson,
        resetLocks,
    } = useOptionGroups({
        groups: [{ key: 'config', defaults: RCLONE_CONFIG_DEFAULTS.config }],
        initial: preset?.args.options,
    })
    const configGroup = optionGroups.config

    const buildArgs = () => ({
        sources: sources!,
        options: {
            config: configGroup.options,
        },
    })

    const submission = useOperationSubmission({
        operation: 'purge',
        problem: () =>
            !sources || sources.length === 0 ? 'Please select a source path' : undefined,
        jsonError,
        cron: cronExpression,
        setCron: setCronExpression,
        buildArgs: buildArgs,
        start: (args) => startPurge(args, { cron: cronExpression }),
        onStarted,
        getMergedOptions,
        error: {
            title: 'Purge',
            message: 'Failed to start purge',
            log: ['[Purge] Failed to start purge:'],
        },
        reset: {
            paths: () => setSources(undefined),
        },
        groups: { setJsonError, resetJson, resetLocks },
    })

    const accordionItems = useMemo<OptionsAccordionItemDef[]>(
        () => [
            {
                key: 'config',
                category: 'config',
                subtitle: getOptionsSubtitle(Object.keys(configGroup.options).length),
                children: (
                    <OptionsSection
                        globalOptions={globalFlags?.main || {}}
                        optionsJson={configGroup.jsonString}
                        setOptionsJson={configGroup.setJsonString}
                        availableOptions={configFlags || []}
                        isLocked={configGroup.locked}
                        setIsLocked={configGroup.setLocked}
                    />
                ),
            },
                      {
                          key: 'cron',
                          category: 'cron' as const,
                          children: (
                              <CronSection
                                  expression={cronExpression}
                                  onChange={setCronExpression}
                              />
                          ),
                      },
        ],
        [configGroup, globalFlags, configFlags, cronExpression]
    )

    return (
        <div className="flex flex-col h-full gap-10">
            {/* Main Content */}
            <OperationWindowContent>
                {/* Path Display */}
                <MultiPathField
                    paths={sources ?? []}
                    setPaths={setSources}
                    label="Path(s)"
                    placeholder="Enter a remote:path to purge"
                    showPicker={true}
                    allowedKeys={PATH_ALLOWED_KEYS}
                    showFiles={false}
                />

                <OptionsAccordion
                    defaultExpandedKeys={DEFAULT_EXPANDED_KEYS}
                    items={accordionItems}
                />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    operation="purge"
                    {...submission.footer}
                    onTemplateSelect={(groupedOptions, shouldMerge, paths) => {
                        applyTemplate(groupedOptions, shouldMerge)
                        const next = applyTemplatePaths(
                            { sources: sources ?? [] },
                            paths,
                            shouldMerge
                        )
                        setSources(next.sources?.length ? next.sources : undefined)
                    }}
                    getTemplateOptions={getMergedOptions}
                    getTemplatePaths={() => ({ sources })}
                    newLabel="NEW PURGE"
                    showViewTransfers={false}
                    resetPathsLabel="Reset Path"
                />
            </OperationWindowFooter>
        </div>
    )
}
