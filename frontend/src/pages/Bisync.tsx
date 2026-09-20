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
        <div className="flex flex-col h-full gap-10">
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
                />
            </OperationWindowFooter>
        </div>
    )
}
