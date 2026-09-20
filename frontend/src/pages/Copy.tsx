import { useMemo, useState } from 'react'
import { getOptionsSubtitle } from '@/lib/flags'
import { pathsWithRemote } from '@/lib/format'
import { useFlags } from '@/lib/hooks'
import { applyTemplatePaths } from '@/lib/rclone/templatePaths'
import { startCopy } from '@/lib/rclone/start'
import { RCLONE_CONFIG_DEFAULTS } from '@/lib/rclone/constants'
import { metadataOptionsProblem } from '@/lib/rclone/metadataMapper'
import OperationWindowContent from '@/components/OperationWindowContent'
import OperationWindowFooter from '@/components/OperationWindowFooter'
import OptionsSection from '@/components/OptionsSection'
import { MultiPathFinder } from '@/components/PathFinder'
import RemoteOptionsSection from '@/components/RemoteOptionsSection'
import { CronSection } from '@/components/CronEditor'
import OperationFooter from '@/components/operation/OperationFooter'
import OptionsAccordion, {
    type OptionsAccordionItemDef,
} from '@/components/operation/OptionsAccordion'
import { useOperationPreset } from '@/components/operation/useOperationPreset'
import { useOperationSubmission } from '@/components/operation/useOperationSubmission'
import { useOptionGroups } from '@/components/operation/useOptionGroups'

export default function Copy() {
    const { preset, onStarted } = useOperationPreset('copy')
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
            { key: 'copy', defaults: RCLONE_CONFIG_DEFAULTS.copy },
            { key: 'filter' },
            { key: 'config', defaults: RCLONE_CONFIG_DEFAULTS.config },
            { key: 'metadata' },
        ],
        withRemotes: true,
        initial: preset?.args.options,
        initialRemotes: preset?.args.options?.remotes,
    })
    const copyGroup = optionGroups.copy
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config
    const metadataGroup = optionGroups.metadata

    const [cronExpression, setCronExpression] = useState<string | null>(preset?.cron ?? null)

    // Only the ends that name a remote: a copy between two local paths has no backend options
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
            copy: copyGroup.options,
            filter: filterGroup.options,
            metadata: metadataGroup.options,
            remotes: remotesGroup.options,
        },
    })

    const submission = useOperationSubmission({
        operation: 'copy',
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
        start: (args) => startCopy(args, false, { cron: cronExpression }),
        dryRun: (args, isDryRun) => startCopy(args, isDryRun),
        onStarted,
        getMergedOptions,
        error: {
            title: 'Copy',
            message: 'Failed to start copy',
            log: ['Error starting copy:'],
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
                key: 'copy',
                category: 'copy',
                subtitle: getOptionsSubtitle(Object.keys(copyGroup.options).length),
                children: (
                    <OptionsSection
                        globalOptions={globalFlags?.main || {}}
                        optionsJson={copyGroup.jsonString}
                        setOptionsJson={copyGroup.setJsonString}
                        availableOptions={copyFlags || []}
                        isLocked={copyGroup.locked}
                        setIsLocked={copyGroup.setLocked}
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
            copyGroup,
            filterGroup,
            configGroup,
            remotesGroup,
            globalFlags,
            copyFlags,
            filterFlags,
            configFlags,
            metadataGroup,
            sources,
            dest,
            metadataFlags,
            selectedRemotes,
            cronExpression,
        ]
    )

    return (
        <div className="flex flex-col h-full gap-10">
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
                    operation="copy"
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
                    newLabel="NEW COPY"
                />
            </OperationWindowFooter>
        </div>
    )
}
