import { useMemo, useState } from 'react'
import { useOperationPreset } from '../components/operation/useOperationPreset'
import { useOperationSubmission } from '../components/operation/useOperationSubmission'
import { getOptionsSubtitle } from '../../lib/flags'
import { useFlags } from '../../lib/hooks'
import { applyTemplatePaths } from '../../lib/rclone/templatePaths'
import { startPurge } from '../../lib/rclone/api'
import { RCLONE_CONFIG_DEFAULTS } from '../../lib/rclone/constants'
import { useSchedulingAvailable } from '../../lib/scheduler'
import OperationWindowContent from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import OptionsSection from '../components/OptionsSection'
import { MultiPathField } from '../components/PathFinder'
import type { AllowedKey } from '../components/navigator/types'
import CronSection from '../components/operation/CronSection'
import OperationFooter from '../components/operation/OperationFooter'
import OptionsAccordion, {
    type OptionsAccordionItemDef,
} from '../components/operation/OptionsAccordion'
import { useOptionGroups } from '../components/operation/useOptionGroups'

const PATH_ALLOWED_KEYS: AllowedKey[] = ['REMOTES', 'FAVORITES']

const DEFAULT_EXPANDED_KEYS = ['config']

const HELP_CONTENT = `Removes a path and ALL of its contents.

Purge completely deletes the specified directory and everything inside it — files, subdirectories, everything. This is a destructive operation that cannot be undone.

Important: Purge does NOT obey include/exclude filters. Everything in the path will be removed regardless of any filter settings. If you need to selectively delete specific files while keeping others, use the "Delete" command instead.

Many cloud storage backends (like Google Drive, Dropbox, OneDrive, S3) support server-side purge, which is much faster than deleting files one by one. Rclone will automatically use this when available.

Here's a quick guide to using the Purge command:

1. SELECT PATH
Use the path selector at the top to choose which path to purge. You can select from configured remotes or favorites. Tap the folder icon to browse, or type a path directly. Double-check that you've selected the correct path — purge will delete everything inside it.

2. CONFIGURE OPTIONS (Optional)
Expand the accordion sections to customize your purge operation. Tap any chip on the right to add it to the JSON editor. Hover over chips to see what each option does.

• Config — The "checkers" option controls concurrency for backends that don't support server-side purge. Other global rclone settings are also available here.

• Schedule — Run this purge automatically at set intervals, even when the app is closed. Useful for automated cleanup of temporary folders.

3. USE TEMPLATES (Optional)
Tap the folder icon in the bottom bar to load or save option presets.

4. START THE PURGE
Once a path is selected, tap "START PURGE" to begin. The entire directory and all its contents will be permanently deleted.`

export default function Purge() {
    const { preset, onStarted } = useOperationPreset('purge')
    const { globalFlags, configFlags } = useFlags()

    const [sources, setSources] = useState<string[] | undefined>(preset?.args.sources)

    const [cronExpression, setCronExpression] = useState<string | null>(preset?.cron ?? null)
    const schedulingAvailable = useSchedulingAvailable()

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
            ...(schedulingAvailable
                ? [
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
                  ]
                : []),
        ],
        [configGroup, globalFlags, configFlags, cronExpression, schedulingAvailable]
    )

    return (
        <div className="flex flex-col h-screen gap-10">
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
                    helpContent={HELP_CONTENT}
                />
            </OperationWindowFooter>
        </div>
    )
}
