import { Switch } from '@heroui/react'
import { useMemo, useState } from 'react'
import { getOptionsSubtitle } from '../../lib/flags'
import { pathsWithRemote } from '../../lib/format'
import { useFlags } from '../../lib/hooks'
import { applyTemplatePaths } from '../../lib/rclone/templatePaths'
import { startBisync } from '../../lib/rclone/api'
import { RCLONE_CONFIG_DEFAULTS } from '../../lib/rclone/constants'
import { metadataOptionsProblem } from '../../lib/rclone/metadataMapper'
import { useSchedulingAvailable } from '../../lib/scheduler'
import OperationWindowContent from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import OptionsSection from '../components/OptionsSection'
import { PathFinder } from '../components/PathFinder'
import RemoteOptionsSection from '../components/RemoteOptionsSection'
import CronSection from '../components/operation/CronSection'
import OperationFooter from '../components/operation/OperationFooter'
import OptionsAccordion, {
    type OptionsAccordionItemDef,
} from '../components/operation/OptionsAccordion'
import { useOperationPreset } from '../components/operation/useOperationPreset'
import { useOperationSubmission } from '../components/operation/useOperationSubmission'
import { useOptionGroups } from '../components/operation/useOptionGroups'

const HELP_CONTENT = `Performs bidirectional synchronization between two paths.

Bisync keeps both Path1 and Path2 in sync by propagating changes in both directions. On each run, it compares the current state to the previous run and detects New, Newer, Older, and Deleted files on each side, then propagates those changes to the other path.

Bisync retains the filesystem listings from the prior run. This history allows it to determine what has changed since the last sync. If something evil happens, bisync goes into a safe state to block damage by later runs — you may need to run with resync to recover.

This is an advanced command — use with care. Unlike Copy or Sync which have a clear "source of truth", Bisync must resolve conflicts when both sides have changed. When a file changes on both sides and the versions differ, bisync will rename both versions as conflicts (e.g., file.conflict1, file.conflict2) so nothing is lost. Make sure you understand the behavior before using on important data.

If you only need one-way synchronization (making destination match source), use the SYNC command instead.

Here's a quick guide to using the Bisync command:

1. SELECT PATHS
Use the path selectors at the top to choose Path1 and Path2. Both paths will be kept in sync with each other — there is no "source" or "destination", changes flow both ways.

2. CONFIGURE OPTIONS (Optional)
Expand the accordion sections to customize your bisync operation. The Bisync section has important switches at the top:

• resync — Required for the first run, or to reset bisync after an error. This makes both paths contain a matching superset of all files by copying Path2 to Path1, then Path1 to Path2. Only use resync when starting fresh, after changing filter settings, or recovering from an error — using it routinely would prevent deletions from syncing (deleted files would keep reappearing from the other side).

• checkAccess — Safety check that looks for matching RCLONE_TEST files on both paths before syncing. You must first create these files yourself in both paths. This prevents data loss if a path is temporarily unavailable or mounted incorrectly.

• force — Override safety checks like max-delete protection. Use with caution, as this bypasses safeguards designed to prevent accidental mass deletions.

• createEmptySrcDirs — Sync empty directories as well as files. Without this, only files are synced and empty directories are ignored.

• removeEmptyDirs — Remove directories that become empty after syncing. Not compatible with createEmptySrcDirs — use one or the other.

• ignoreListingChecksum — Skip checksum retrieval when creating file listings, which can speed things up considerably on backends where hashes must be computed on the fly (like local). Note this only affects listing comparisons, not the actual sync operations.

• resilient — Allow bisync to retry on the next run after certain errors, instead of requiring a resync. Useful for running bisync as a scheduled background process. Combine with --recover and --max-lock for a robust "set-it-and-forget-it" setup.

• noCleanup — Don't delete temporary working files after the operation. Useful for debugging issues, but normally you should leave this off.

3. OTHER OPTIONS
Tap any chip on the right to add it to the JSON editor. Hover over chips to see what each option does.

• Filters — Include or exclude files by pattern, limit by size (max_size, min_size) or age (max_age, min_age).

• Config — Performance tuning: parallel transfers, checkers, buffer_size, bandwidth limits (bwlimit), and fast_list for faster directory listings on supported remotes.
• Metadata — Whether to preserve object metadata (metadata), a program that rewrites it (metadata_mapper), and metadata include/exclude/filter rules.

• Remotes — Override backend-specific settings for remotes involved in this operation.

4. START BISYNC
Once paths are selected, tap "START BISYNC" to begin. For your first run, make sure "resync" is enabled to establish the initial baseline. You can monitor progress on the Transfers page.`

export default function Bisync() {
    const { preset, onStarted } = useOperationPreset('bisync')
    const { globalFlags, filterFlags, configFlags, copyFlags, metadataFlags } = useFlags()

    const [source, setSource] = useState<string | undefined>(preset?.args.source)
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
            { key: 'bisync', templateKey: 'copy', defaults: RCLONE_CONFIG_DEFAULTS.copy },
            { key: 'filter' },
            { key: 'config', defaults: RCLONE_CONFIG_DEFAULTS.config },
            { key: 'metadata' },
        ],
        withRemotes: true,
        initial: preset?.args.options,
        initialRemotes: preset?.args.options?.remotes,
    })
    const bisyncGroup = optionGroups.bisync
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config
    const metadataGroup = optionGroups.metadata

    const [outerBisyncOptions, setOuterBisyncOptions] = useState<Record<string, boolean>>(
        (preset?.args.options?.outer as Record<string, boolean> | undefined) ?? {}
    )

    const [cronExpression, setCronExpression] = useState<string | null>(preset?.cron ?? null)
    const schedulingAvailable = useSchedulingAvailable()

    // Only the ends that name a remote: a bisync between two local paths has no backend options
    // to set, and the section would open on an empty tab strip.
    const selectedRemotes = useMemo(() => pathsWithRemote([source, dest]), [source, dest])

    const buildStartArgs = () => ({
        source: source!,
        destination: dest!,
        options: {
            config: configGroup.options,
            bisync: bisyncGroup.options,
            filter: filterGroup.options,
            metadata: metadataGroup.options,
            remotes: remotesGroup.options,
            outer: outerBisyncOptions,
        },
    })

    // The persisted schedule args deliberately omit the outer bisync switches — do not merge
    // this with buildStartArgs.
    const buildScheduleArgs = () => ({
        source: source!,
        destination: dest!,
        options: {
            config: configGroup.options,
            bisync: bisyncGroup.options,
            filter: filterGroup.options,
            metadata: metadataGroup.options,
            remotes: remotesGroup.options,
        },
    })

    const submission = useOperationSubmission({
        operation: 'bisync',
        problem: () =>
            !source
                ? 'Please select a source path'
                : !dest
                  ? 'Please select a destination path'
                  : source === dest
                    ? 'Source and destination cannot be the same'
                    : metadataOptionsProblem(metadataGroup.options),
        jsonError,
        cron: cronExpression,
        setCron: setCronExpression,
        buildArgs: buildStartArgs,
        buildScheduleArgs: buildScheduleArgs,
        start: (args) => startBisync(args, { cron: cronExpression }),
        onStarted,
        getMergedOptions,
        error: {
            title: 'Bisync',
            message: 'Failed to start bisync operation',
            capture: false,
            log: ['Error starting bisync:'],
        },
        reset: {
            paths: () => {
                setSource(undefined)
                setDest(undefined)
            },
            extras: () => setOuterBisyncOptions({}),
        },
        groups: { setJsonError, resetJson, resetLocks },
    })

    const accordionItems = useMemo<OptionsAccordionItemDef[]>(
        () => [
            {
                key: 'bisync',
                category: 'bisync',
                subtitle: getOptionsSubtitle(Object.keys(bisyncGroup.options).length),
                children: (
                    <>
                        <div className="flex flex-row flex-wrap gap-2 pb-5">
                            <Switch
                                isSelected={outerBisyncOptions?.resync}
                                onValueChange={(value) =>
                                    setOuterBisyncOptions({
                                        ...outerBisyncOptions,
                                        resync: value,
                                    })
                                }
                                size="sm"
                            >
                                resync
                            </Switch>

                            <Switch
                                isSelected={outerBisyncOptions?.checkAccess}
                                onValueChange={(value) =>
                                    setOuterBisyncOptions({
                                        ...outerBisyncOptions,
                                        checkAccess: value,
                                    })
                                }
                                size="sm"
                            >
                                checkAccess
                            </Switch>

                            <Switch
                                isSelected={outerBisyncOptions?.force}
                                onValueChange={(value) =>
                                    setOuterBisyncOptions({
                                        ...outerBisyncOptions,
                                        force: value,
                                    })
                                }
                                size="sm"
                            >
                                force
                            </Switch>

                            <Switch
                                isSelected={outerBisyncOptions?.createEmptySrcDirs}
                                onValueChange={(value) =>
                                    setOuterBisyncOptions({
                                        ...outerBisyncOptions,
                                        createEmptySrcDirs: value,
                                    })
                                }
                                size="sm"
                            >
                                createEmptySrcDirs
                            </Switch>

                            <Switch
                                isSelected={outerBisyncOptions?.removeEmptyDirs}
                                onValueChange={(value) =>
                                    setOuterBisyncOptions({
                                        ...outerBisyncOptions,
                                        removeEmptyDirs: value,
                                    })
                                }
                                size="sm"
                            >
                                removeEmptyDirs
                            </Switch>

                            <Switch
                                isSelected={outerBisyncOptions?.ignoreListingChecksum}
                                onValueChange={(value) =>
                                    setOuterBisyncOptions({
                                        ...outerBisyncOptions,
                                        ignoreListingChecksum: value,
                                    })
                                }
                                size="sm"
                            >
                                ignoreListingChecksum
                            </Switch>

                            <Switch
                                isSelected={outerBisyncOptions?.resilient}
                                onValueChange={(value) =>
                                    setOuterBisyncOptions({
                                        ...outerBisyncOptions,
                                        resilient: value,
                                    })
                                }
                                size="sm"
                            >
                                resilient
                            </Switch>

                            <Switch
                                isSelected={outerBisyncOptions?.noCleanup}
                                onValueChange={(value) =>
                                    setOuterBisyncOptions({
                                        ...outerBisyncOptions,
                                        noCleanup: value,
                                    })
                                }
                                size="sm"
                            >
                                noCleanup
                            </Switch>
                        </div>
                        <OptionsSection
                            globalOptions={globalFlags?.main || {}}
                            optionsJson={bisyncGroup.jsonString}
                            setOptionsJson={bisyncGroup.setJsonString}
                            availableOptions={copyFlags || []}
                            isLocked={bisyncGroup.locked}
                            setIsLocked={bisyncGroup.setLocked}
                        />
                    </>
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
                        mapperPaths={{ source: source, destination: dest }}
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
            bisyncGroup,
            outerBisyncOptions,
            globalFlags,
            copyFlags,
            filterGroup,
            filterFlags,
            configGroup,
            configFlags,
            metadataGroup,
            source,
            dest,
            metadataFlags,
            selectedRemotes,
            remotesGroup,
            cronExpression,
            schedulingAvailable,
        ]
    )

    return (
        <div className="flex flex-col h-screen gap-10">
            {/* Main Content */}
            <OperationWindowContent>
                {/* Paths Display */}
                <PathFinder
                    sourcePath={source}
                    setSourcePath={setSource}
                    destPath={dest}
                    setDestPath={setDest}
                />

                <OptionsAccordion items={accordionItems} />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    operation="bisync"
                    {...submission.footer}
                    onTemplateSelect={(groupedOptions, shouldMerge, paths) => {
                        applyTemplate(groupedOptions, shouldMerge)
                        const next = applyTemplatePaths(
                            { sources: source ? [source] : [], destination: dest },
                            paths,
                            shouldMerge
                        )
                        setSource(next.sources?.[0])
                        setDest(next.destination)
                    }}
                    getTemplateOptions={getMergedOptions}
                    getTemplatePaths={() => ({
                        sources: source ? [source] : undefined,
                        destination: dest,
                    })}
                    newLabel="NEW BISYNC"
                    helpContent={HELP_CONTENT}
                />
            </OperationWindowFooter>
        </div>
    )
}
