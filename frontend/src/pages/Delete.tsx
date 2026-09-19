import { Alert } from '@heroui/react'
import { useMemo, useState } from 'react'
import { getOptionsSubtitle } from '../../lib/flags'
import { getRemoteName } from '../../lib/format'
import { hasFeature, useFlags, useFsInfo } from '../../lib/hooks'
import { applyTemplatePaths } from '../../lib/rclone/templatePaths'
import { notify } from '../../lib/notifications'
import { startDelete } from '../../lib/rclone/api'
import { RCLONE_CONFIG_DEFAULTS } from '../../lib/rclone/constants'
import { metadataOptionsProblem } from '../../lib/rclone/metadataMapper'
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
import { useOperationPreset } from '../components/operation/useOperationPreset'
import { useOperationSubmission } from '../components/operation/useOperationSubmission'
import { useOptionGroups } from '../components/operation/useOptionGroups'

const PATH_ALLOWED_KEYS: AllowedKey[] = ['REMOTES', 'FAVORITES']

const HELP_CONTENT = `Removes files from the specified path.

Unlike "Purge", Delete obeys include/exclude filters, so you can use it to selectively delete specific files. Delete only removes files but leaves the directory structure intact — empty folders will remain after the files are deleted.

If you want to delete an entire directory and all of its contents (ignoring filters), use the Purge command instead. Purge is also more efficient for deleting entire folders on remotes that support server-side deletion.

Here's a quick guide to using the Delete command:

1. SELECT PATH
Use the path selector at the top to choose which path to delete files from. You can select from configured remotes or favorites. Tap the folder icon to browse, or type a path directly.

2. CONFIGURE OPTIONS (Optional)
Expand the accordion sections to customize your delete operation. Tap any chip on the right to add it to the JSON editor. Hover over chips to see what each option does.

• Filters — This is where Delete really shines. Use include/exclude patterns to selectively delete specific files. For example, delete only .tmp files, or only files older than a certain age (max_age), or only files larger than a certain size (min_size).

• Config — Performance tuning: parallel checkers, and other global rclone settings.
• Metadata — Whether to preserve object metadata (metadata), a program that rewrites it (metadata_mapper), and metadata include/exclude/filter rules.

• Schedule — Run this delete automatically at set intervals, for as long as the server is running. Useful for automated cleanup tasks.

3. USE TEMPLATES (Optional)
Tap the folder icon in the bottom bar to load or save option presets. Templates let you quickly apply common filter configurations for recurring cleanup tasks.

4. START THE DELETE
Once a path is selected, tap "START DELETE" to begin. The operation will delete all files matching your filters (or all files if no filters are set). Empty directories will be left behind unless you use the rmdirs option.`

export default function Delete() {
    const { preset, onStarted } = useOperationPreset('delete')
    const { globalFlags, filterFlags, configFlags, metadataFlags } = useFlags()

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
        groups: [
            { key: 'filter' },
            { key: 'config', defaults: RCLONE_CONFIG_DEFAULTS.config },
            { key: 'metadata' },
        ],
        initial: preset?.args.options,
    })
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config
    const metadataGroup = optionGroups.metadata

    const sourceRemoteName = useMemo(() => getRemoteName(sources?.[0]), [sources])

    const sourceFsInfoQuery = useFsInfo(sourceRemoteName)

    // false while loading — matches the previous default (offer the plain delete until purge is
    // confirmed). Only asked of one path: the tip names a remote, and with several selected there
    // is no one remote to name.
    const supportsPurge = useMemo(
        () => sources?.length === 1 && hasFeature(sourceFsInfoQuery.data, 'Purge'),
        [sources, sourceFsInfoQuery.data]
    )

    const buildArgs = () => ({
        sources: sources!,
        options: {
            filter: filterGroup.options,
            metadata: metadataGroup.options,
            config: configGroup.options,
        },
    })

    const submission = useOperationSubmission({
        operation: 'delete',
        problem: () =>
            !sources || sources.length === 0
                ? 'Please select a source path'
                : metadataOptionsProblem(metadataGroup.options),
        jsonError,
        cron: cronExpression,
        setCron: setCronExpression,
        buildArgs: buildArgs,
        start: (args) => startDelete(args, false, { cron: cronExpression }),
        dryRun: (args, isDryRun) => startDelete(args, isDryRun),
        onStarted,
        getMergedOptions,
        afterStart: () => notify({ title: 'Success', body: 'Delete task started' }),
        error: {
            title: 'Delete',
            message: 'Failed to start delete',
            log: ['Error starting delete:'],
        },
        reset: {
            paths: () => setSources(undefined),
        },
        groups: { setJsonError, resetJson, resetLocks },
    })

    const accordionItems = useMemo<OptionsAccordionItemDef[]>(
        () => [
            {
                key: 'filters',
                category: 'filters',
                subtitle: getOptionsSubtitle(Object.keys(filterGroup.options).length),
                children: (
                    <OptionsSection
                        globalOptions={globalFlags?.filter ?? {}}
                        optionsJson={filterGroup.jsonString}
                        setOptionsJson={filterGroup.setJsonString}
                        availableOptions={filterFlags || []}
                        isLocked={filterGroup.locked}
                        setIsLocked={filterGroup.setLocked}
                    />
                ),
            },
            {
                key: 'config',
                category: 'config',
                subtitle: getOptionsSubtitle(Object.keys(configGroup.options).length),
                children: (
                    <OptionsSection
                        globalOptions={globalFlags?.main ?? {}}
                        optionsJson={configGroup.jsonString}
                        setOptionsJson={configGroup.setJsonString}
                        availableOptions={configFlags || []}
                        isLocked={configGroup.locked}
                        setIsLocked={configGroup.setLocked}
                    />
                ),
            },
            {
                key: 'metadata',
                category: 'metadata',
                subtitle: getOptionsSubtitle(Object.keys(metadataGroup.options).length),
                children: (
                    <OptionsSection
                        globalOptions={{ ...globalFlags?.main, ...globalFlags?.filter }}
                        optionsJson={metadataGroup.jsonString}
                        setOptionsJson={metadataGroup.setJsonString}
                        mapperPaths={{ source: sources?.[0] }}
                        availableOptions={metadataFlags || []}
                        isLocked={metadataGroup.locked}
                        setIsLocked={metadataGroup.setLocked}
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
        [
            filterGroup,
            configGroup,
            globalFlags,
            filterFlags,
            configFlags,
            metadataGroup,
            sources,
            metadataFlags,
            cronExpression,
            schedulingAvailable,
        ]
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
                    placeholder="Enter a remote:path to delete"
                    showPicker={true}
                    allowedKeys={PATH_ALLOWED_KEYS}
                    showFiles={true}
                />

                {supportsPurge && (
                    <Alert
                        color="primary"
                        title="LET ME SHARE A TIP!"
                        variant="faded"
                        className="min-h-none h-fit max-h-fit"
                    >
                        If you're deleting a entire folder, "{sourceRemoteName}" supports Purge
                        which is more efficient.
                    </Alert>
                )}

                <OptionsAccordion items={accordionItems} />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    operation="delete"
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
                    newLabel="NEW DELETE"
                    showViewTransfers={false}
                    resetPathsLabel="Reset Path"
                    helpContent={HELP_CONTENT}
                />
            </OperationWindowFooter>
        </div>
    )
}
