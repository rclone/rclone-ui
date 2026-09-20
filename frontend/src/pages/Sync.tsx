import { useMemo, useState } from 'react'
import { getOptionsSubtitle } from '@/lib/flags'
import { pathsWithRemote } from '@/lib/format'
import { useFlags } from '@/lib/hooks'
import { applyTemplatePaths } from '@/lib/rclone/templatePaths'
import { startSync } from '@/lib/rclone/start'
import { RCLONE_CONFIG_DEFAULTS } from '@/lib/rclone/constants'
import { metadataOptionsProblem } from '@/lib/rclone/metadataMapper'
import { useSchedulingAvailable } from '@/lib/scheduler'
import OperationWindowContent from '@/components/OperationWindowContent'
import OperationWindowFooter from '@/components/OperationWindowFooter'
import OptionsSection from '@/components/OptionsSection'
import { PathFinder } from '@/components/PathFinder'
import RemoteOptionsSection from '@/components/RemoteOptionsSection'
import type { AllowedKey } from '@/components/navigator/types'
import { CronSection } from '@/components/CronEditor'
import OperationFooter from '@/components/operation/OperationFooter'
import OptionsAccordion, {
    type OptionsAccordionItemDef,
} from '@/components/operation/OptionsAccordion'
import { useOperationPreset } from '@/components/operation/useOperationPreset'
import { useOperationSubmission } from '@/components/operation/useOperationSubmission'
import { useOptionGroups } from '@/components/operation/useOptionGroups'

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
        <div className="flex flex-col h-full gap-10">
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
                />
            </OperationWindowFooter>
        </div>
    )
}
