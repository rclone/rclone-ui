import { useMemo, useState } from 'react'
import { getOptionsSubtitle } from '../../lib/flags'
import { pathsWithRemote } from '../../lib/format'
import { useFlags } from '../../lib/hooks'
import { applyTemplatePaths } from '../../lib/rclone/templatePaths'
import { startMove } from '../../lib/rclone/api'
import { RCLONE_CONFIG_DEFAULTS } from '../../lib/rclone/constants'
import { metadataOptionsProblem } from '../../lib/rclone/metadataMapper'
import { useSchedulingAvailable } from '../../lib/scheduler'
import OperationWindowContent from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import OptionsSection from '../components/OptionsSection'
import { MultiPathFinder } from '../components/PathFinder'
import RemoteOptionsSection from '../components/RemoteOptionsSection'
import CronSection from '../components/operation/CronSection'
import OperationFooter from '../components/operation/OperationFooter'
import OptionsAccordion, {
    type OptionsAccordionItemDef,
} from '../components/operation/OptionsAccordion'
import { useOperationPreset } from '../components/operation/useOperationPreset'
import { useOperationSubmission } from '../components/operation/useOperationSubmission'
import { useOptionGroups } from '../components/operation/useOptionGroups'

const HELP_CONTENT = `Moves the source(s) to the destination directory.

Unlike Copy, Move deletes files from the source after they have been transferred to the destination. After a successful move, the source path will no longer exist.

When possible, rclone uses efficient server-side moves. If server-side move isn't supported, it will copy the file to the destination then delete the original (only if the copy succeeds without errors).

Note: Rclone will error if the source and destination overlap and the remote does not support server-side directory moves. Modification times are synced if the backend supports it.

If you want to keep files in the source location, use the COPY command instead.

Here's a quick guide to using the Move command:

1. SELECT PATHS
Use the path selectors at the top to choose your source(s) and destination. You can select from local filesystem, configured remotes, or favorites. Tap the folder icon to browse, or type a path directly. Use the swap button to quickly switch source and destination.

2. CONFIGURE OPTIONS (Optional)
Expand the accordion sections to customize your move operation. Tap any chip on the right to add it to the JSON editor. Hover over chips to see what each option does.

• Move — Multi-threading settings (multi_thread_cutoff, streams, chunk_size), checksum verification, and how to handle existing files (ignore_existing).

• Filters — Include or exclude files by pattern, limit by size (max_size, min_size) or age (max_age, min_age).

• Schedule — Run this move automatically at set intervals, for as long as the server is running.

• Config — Performance tuning: parallel transfers, checkers, buffer_size, bandwidth limits (bwlimit), and fast_list for faster directory listings on supported remotes.
• Metadata — Whether to preserve object metadata (metadata), a program that rewrites it (metadata_mapper), and metadata include/exclude/filter rules.

• Remotes — Override backend-specific settings for remotes involved in this operation.

3. USE TEMPLATES (Optional)
Tap the folder icon in the bottom bar to load or save option presets. Templates let you quickly apply common configurations without manually setting each option.

4. START THE MOVE
Once paths are selected, tap "START MOVE" to begin. You can monitor progress on the Transfers page.`

export default function Move() {
    const { preset, onStarted } = useOperationPreset('move')
    const { globalFlags, filterFlags, configFlags, copyFlags, metadataFlags } = useFlags()

    const [sources, setSources] = useState<string[] | undefined>(preset?.args.sources)
    const [dest, setDest] = useState<string | undefined>(preset?.args.destination)

    const {
        jsonError,
        setJsonError,
        groups: optionGroups,
        remotes: remotesGroup,
        applyTemplate,
        getMergedOptions,
        resetJson,
        resetLocks,
    } = useOptionGroups({
        groups: [
            { key: 'move', templateKey: 'copy', defaults: RCLONE_CONFIG_DEFAULTS.copy },
            { key: 'filter' },
            { key: 'config', defaults: RCLONE_CONFIG_DEFAULTS.config },
            { key: 'metadata' },
        ],
        withRemotes: true,
        initial: preset?.args.options,
        initialRemotes: preset?.args.options?.remotes,
    })
    const moveGroup = optionGroups.move
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config
    const metadataGroup = optionGroups.metadata

    const [cronExpression, setCronExpression] = useState<string | null>(preset?.cron ?? null)
    const schedulingAvailable = useSchedulingAvailable()

    // Only the ends that name a remote: a move between two local paths has no backend options
    // to set, and the section would open on an empty tab strip.
    const selectedRemotes = useMemo(
        () => pathsWithRemote([...(sources || []), dest]),
        [sources, dest]
    )

    const buildArgs = () => ({
        sources: sources!,
        destination: dest!,
        options: {
            config: configGroup.options,
            move: moveGroup.options,
            filter: filterGroup.options,
            metadata: metadataGroup.options,
            remotes: remotesGroup.options,
        },
    })

    const submission = useOperationSubmission({
        operation: 'move',
        problem: () =>
            !sources || sources.length === 0
                ? 'Please select a source path'
                : !dest
                  ? 'Please select a destination path'
                  : sources.some((s) => s === dest)
                    ? 'Source and destination cannot be the same'
                    : metadataOptionsProblem(metadataGroup.options),
        jsonError,
        cron: cronExpression,
        setCron: setCronExpression,
        buildArgs: buildArgs,
        start: (args) => startMove(args, false, { cron: cronExpression }),
        dryRun: (args, isDryRun) => startMove(args, isDryRun),
        onStarted,
        getMergedOptions,
        error: {
            title: 'Move',
            message: 'Failed to start move',
            capture: false,
            log: ['Error starting move:'],
        },
        reset: {
            paths: () => {
                setSources(undefined)
                setDest(undefined)
            },
        },
        groups: { setJsonError, resetJson, resetLocks },
    })

    const accordionItems = useMemo<OptionsAccordionItemDef[]>(
        () => [
            {
                key: 'move',
                category: 'move',
                subtitle: getOptionsSubtitle(Object.keys(moveGroup.options).length),
                children: (
                    <OptionsSection
                        globalOptions={globalFlags?.main || {}}
                        optionsJson={moveGroup.jsonString}
                        setOptionsJson={moveGroup.setJsonString}
                        availableOptions={copyFlags || []}
                        isLocked={moveGroup.locked}
                        setIsLocked={moveGroup.setLocked}
                    />
                ),
            },
            {
                key: 'filters',
                category: 'filters',
                subtitle: getOptionsSubtitle(Object.keys(filterGroup.options).length),
                children: (
                    <OptionsSection
                        globalOptions={globalFlags?.filter || {}}
                        optionsJson={filterGroup.jsonString}
                        setOptionsJson={filterGroup.setJsonString}
                        availableOptions={filterFlags || []}
                        isLocked={filterGroup.locked}
                        setIsLocked={filterGroup.setLocked}
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
                key: 'metadata',
                category: 'metadata',
                subtitle: getOptionsSubtitle(Object.keys(metadataGroup.options).length),
                children: (
                    <OptionsSection
                        globalOptions={{ ...globalFlags?.main, ...globalFlags?.filter }}
                        optionsJson={metadataGroup.jsonString}
                        setOptionsJson={metadataGroup.setJsonString}
                        mapperPaths={{ source: sources?.[0], destination: dest }}
                        mapperRemoteOverrides={remotesGroup.options}
                        availableOptions={metadataFlags || []}
                        isLocked={metadataGroup.locked}
                        setIsLocked={metadataGroup.setLocked}
                    />
                ),
            },
            ...(selectedRemotes.length > 0
                ? [
                      {
                          key: 'remotes',
                          category: 'remotes' as const,
                          subtitle: getOptionsSubtitle(
                              Object.values(remotesGroup.options).reduce(
                                  (acc, opts) => acc + Object.keys(opts).length,
                                  0
                              )
                          ),
                          children: (
                              <RemoteOptionsSection
                                  selectedRemotes={selectedRemotes}
                                  remoteOptionsJson={remotesGroup.json}
                                  setRemoteOptionsJson={remotesGroup.setJson}
                                  reconcileRemotes={remotesGroup.reconcile}
                                  setRemoteOptionsLocked={remotesGroup.setLocked}
                                  remoteOptionsLocked={remotesGroup.locked}
                              />
                          ),
                      },
                  ]
                : []),
        ],
        [
            moveGroup,
            filterGroup,
            configGroup,
            remotesGroup,
            globalFlags,
            filterFlags,
            configFlags,
            metadataGroup,
            sources,
            dest,
            metadataFlags,
            copyFlags,
            selectedRemotes,
            cronExpression,
            schedulingAvailable,
        ]
    )

    return (
        <div className="flex flex-col h-screen gap-10">
            {/* Main Content */}
            <OperationWindowContent>
                {/* Paths Display */}
                <MultiPathFinder
                    sourcePaths={sources}
                    setSourcePaths={setSources}
                    destPath={dest}
                    setDestPath={setDest}
                />

                <OptionsAccordion banner={true} items={accordionItems} />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    operation="move"
                    {...submission.footer}
                    onTemplateSelect={(groupedOptions, shouldMerge, paths) => {
                        applyTemplate(groupedOptions, shouldMerge)
                        const next = applyTemplatePaths(
                            { sources, destination: dest },
                            paths,
                            shouldMerge
                        )
                        setSources(next.sources?.length ? next.sources : undefined)
                        setDest(next.destination)
                    }}
                    getTemplateOptions={getMergedOptions}
                    getTemplatePaths={() => ({ sources, destination: dest })}
                    newLabel="NEW MOVE"
                    helpContent={HELP_CONTENT}
                />
            </OperationWindowFooter>
        </div>
    )
}
