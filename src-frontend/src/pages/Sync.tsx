import { useMemo, useState } from 'react'
import { getOptionsSubtitle } from '../../lib/flags'
import { pathsWithRemote } from '../../lib/format'
import { useFlags } from '../../lib/hooks'
import { applyTemplatePaths } from '../../lib/rclone/templatePaths'
import { startSync } from '../../lib/rclone/api'
import { RCLONE_CONFIG_DEFAULTS } from '../../lib/rclone/constants'
import { metadataOptionsProblem } from '../../lib/rclone/metadataMapper'
import { useSchedulingAvailable } from '../../lib/scheduler'
import OperationWindowContent from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import OptionsSection from '../components/OptionsSection'
import { PathFinder } from '../components/PathFinder'
import RemoteOptionsSection from '../components/RemoteOptionsSection'
import type { AllowedKey } from '../components/navigator/types'
import CronSection from '../components/operation/CronSection'
import OperationFooter from '../components/operation/OperationFooter'
import OptionsAccordion, {
    type OptionsAccordionItemDef,
} from '../components/operation/OptionsAccordion'
import { useOperationPreset } from '../components/operation/useOperationPreset'
import { useOperationSubmission } from '../components/operation/useOperationSubmission'
import { useOptionGroups } from '../components/operation/useOptionGroups'

const PATH_ALLOWED_KEYS: AllowedKey[] = ['LOCAL_FS', 'LOCAL_FS_EXTRA', 'REMOTES', 'FAVORITES']

const SOURCE_OPTIONS = {
    label: 'Source',
    showPicker: true,
    placeholder: 'Enter a remote:path or local path, or tap to select a folder',
    clearable: true,
    showFiles: true,
    allowedKeys: PATH_ALLOWED_KEYS,
}

const DEST_OPTIONS = {
    label: 'Destination',
    showPicker: true,
    placeholder: 'Enter a remote:path or local path',
    clearable: true,
    showFiles: false,
    allowedKeys: PATH_ALLOWED_KEYS,
}

const HELP_CONTENT = `Sync the source to the destination, changing the destination only. Doesn't transfer files that are identical on source and destination, testing by size and modification time or MD5SUM. Destination is updated to match source, including deleting files if necessary (except duplicate objects, see below). If you don't want to delete files from destination, use the COPY command instead.
					
Files in the destination won't be deleted if there were any errors at any point. Duplicate objects (files with the same name, on those providers that support it) are not yet handled.

It is always the contents of the directory that is synced, not the directory itself. So when source:path is a directory, it's the contents of source:path that are copied, not the directory name and contents.

If dest:path doesn't exist, it is created and the source:path contents go there.

It is not possible to sync overlapping remotes. However, you may exclude the destination from the sync with a filter rule or by putting an exclude-if-present file inside the destination directory and sync to a destination that is inside the source directory.

Rclone will sync the modification times of files and directories if the backend supports it.

Here's a quick guide to using the Sync command:

1. SELECT PATHS
Use the path selectors at the top to choose your source and destination. You can select from local filesystem, configured remotes, or favorites. Tap the folder icon to browse, or type a path directly. Use the swap button to quickly switch source and destination.

2. CONFIGURE OPTIONS (Optional)
Expand the accordion sections to customize your sync operation. Tap any chip on the right to add it to the JSON editor. Hover over chips to see what each option does.

• Sync — Multi-threading settings (multi_thread_cutoff, streams, chunk_size), checksum verification, and how to handle existing files (ignore_existing).

• Filters — Include or exclude files by pattern, limit by size (max_size, min_size) or age (max_age, min_age).

• Schedule — Run this sync automatically at set intervals, even when the app is closed.

• Config — Performance tuning: parallel transfers, checkers, buffer_size, bandwidth limits (bwlimit), and fast_list for faster directory listings on supported remotes.
• Metadata — Whether to preserve object metadata (metadata), a program that rewrites it (metadata_mapper), and metadata include/exclude/filter rules.

• Remotes — Override backend-specific settings for remotes involved in this operation.

3. USE TEMPLATES (Optional)
Tap the folder icon in the bottom bar to load or save option presets. Templates let you quickly apply common configurations without manually setting each option.

4. START THE SYNC
Once paths are selected, tap "START SYNC" to begin. You can monitor progress on the Transfers page.`

export default function Sync() {
    const { preset, onStarted } = useOperationPreset('sync')
    const { globalFlags, filterFlags, configFlags, syncFlags, metadataFlags } = useFlags()

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
            { key: 'sync', defaults: RCLONE_CONFIG_DEFAULTS.copy },
            { key: 'filter' },
            { key: 'config', defaults: RCLONE_CONFIG_DEFAULTS.config },
            { key: 'metadata' },
        ],
        withRemotes: true,
        initial: preset?.args.options,
        initialRemotes: preset?.args.options?.remotes,
    })
    const syncGroup = optionGroups.sync
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config
    const metadataGroup = optionGroups.metadata

    const [cronExpression, setCronExpression] = useState<string | null>(preset?.cron ?? null)
    const schedulingAvailable = useSchedulingAvailable()

    // Only the ends that name a remote: a sync between two local paths has no backend options
    // to set, and the section would open on an empty tab strip.
    const selectedRemotes = useMemo(() => pathsWithRemote([source, dest]), [source, dest])

    const buildArgs = () => ({
        source: source!,
        destination: dest!,
        options: {
            config: configGroup.options,
            sync: syncGroup.options,
            filter: filterGroup.options,
            metadata: metadataGroup.options,
            remotes: remotesGroup.options,
        },
    })

    const submission = useOperationSubmission({
        operation: 'sync',
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
        buildArgs: buildArgs,
        start: (args) => startSync(args, false, { cron: cronExpression }),
        dryRun: (args, isDryRun) => startSync(args, isDryRun),
        onStarted,
        getMergedOptions,
        error: { title: 'Sync', message: 'Failed to start sync', log: ['Error starting sync:'] },
        reset: {
            paths: () => {
                setSource(undefined)
                setDest(undefined)
            },
        },
        groups: { setJsonError, resetJson, resetLocks },
    })

    const accordionItems = useMemo<OptionsAccordionItemDef[]>(
        () => [
            {
                key: 'sync',
                category: 'sync',
                subtitle: getOptionsSubtitle(Object.keys(syncGroup.options).length),
                children: (
                    <OptionsSection
                        optionsJson={syncGroup.jsonString}
                        setOptionsJson={syncGroup.setJsonString}
                        globalOptions={globalFlags?.main || {}}
                        availableOptions={syncFlags || []}
                        isLocked={syncGroup.locked}
                        setIsLocked={syncGroup.setLocked}
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
            syncGroup,
            filterGroup,
            configGroup,
            globalFlags,
            syncFlags,
            filterFlags,
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
                    sourceOptions={SOURCE_OPTIONS}
                    destOptions={DEST_OPTIONS}
                />

                <OptionsAccordion banner={true} items={accordionItems} />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    operation="sync"
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
                    newLabel="NEW SYNC"
                    helpContent={HELP_CONTENT}
                />
            </OperationWindowFooter>
        </div>
    )
}
