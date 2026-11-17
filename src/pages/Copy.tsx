import { useMutation } from '@tanstack/react-query'
import { AlertOctagonIcon, FoldersIcon, PlayIcon } from 'lucide-react'
import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { onErrorDialog } from '../../lib/errors'
import { getOptionsSubtitle } from '../../lib/flags'
import { useFlags } from '../../lib/hooks'
import { startCopy, startDryRun } from '../../lib/rclone/api'
import { RCLONE_CONFIG_DEFAULTS } from '../../lib/rclone/constants'
import { useSchedulingAvailable } from '../../lib/scheduler'
import { usePersistedStore } from '../../store/persisted'
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
import { useOperationDryRun } from '../components/operation/useOperationDryRun'
import { useOptionGroups } from '../components/operation/useOptionGroups'
import { useScheduleTask } from '../components/operation/useScheduleTask'

const HELP_CONTENT = `Copies the source(s) to the destination.

Does not transfer files that are identical on source and destination (testing by size and modification time or MD5SUM). Does not delete files from the destination. If the destination path doesn't exist, it will be created automatically.

If you want to also delete files from the destination to make it match the source exactly, use the SYNC command instead.

Here's a quick guide to using the Copy command:

1. SELECT PATHS
Use the path selectors at the top to choose your source(s) and destination. You can select from local filesystem, configured remotes, or favorites. Tap the folder icon to browse, or type a path directly. Use the swap button to quickly switch source and destination.

2. CONFIGURE OPTIONS (Optional)
Expand the accordion sections to customize your copy operation. Tap any chip on the right to add it to the JSON editor. Hover over chips to see what each option does.

• Copy — Multi-threading settings (multi_thread_cutoff, streams, chunk_size), checksum verification, how to handle existing files (ignore_existing), and metadata preservation.

• Filters — Include or exclude files by pattern, limit by size (max_size, min_size) or age (max_age, min_age).

• Cron — Schedule this copy to run automatically at set intervals. It runs even when the app is closed.

• Config — Performance tuning: parallel transfers, checkers, buffer_size, bandwidth limits (bwlimit), and fast_list for faster directory listings on supported remotes.

• Remotes — Override backend-specific settings for remotes involved in this operation.

3. USE TEMPLATES (Optional)
Tap the folder icon in the bottom bar to load or save option presets. Templates let you quickly apply common configurations without manually setting each option.

4. START THE COPY
Once paths are selected, tap "START COPY" to begin. You can monitor progress on the Transfers page.`

export default function Copy() {
    const [searchParams] = useSearchParams()
    const { globalFlags, filterFlags, configFlags, copyFlags } = useFlags()

    const [sources, setSources] = useState<string[] | undefined>(
        searchParams.get('initialSource') ? [searchParams.get('initialSource')!] : undefined
    )
    const [dest, setDest] = useState<string | undefined>(
        searchParams.get('initialDest') ? searchParams.get('initialDest')! : undefined
    )

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
        ],
        withRemotes: true,
    })
    const copyGroup = optionGroups.copy
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config

    const [cronExpression, setCronExpression] = useState<string | null>(null)
    const schedulingAvailable = useSchedulingAvailable()

    const selectedRemotes = useMemo(
        () => [...(sources || []), dest].filter(Boolean),
        [sources, dest]
    )

    const buildArgs = () => ({
        sources: sources!,
        destination: dest!,
        options: {
            config: configGroup.options,
            copy: copyGroup.options,
            filter: filterGroup.options,
            remotes: remotesGroup.options,
        },
    })

    const startCopyMutation = useMutation({
        mutationFn: async () => {
            if (!sources || sources.length === 0 || !dest) {
                throw new Error('Please select both a source and destination path')
            }

            return startCopy(buildArgs())
        },
        onSuccess: () => {
            if (cronExpression) {
                scheduleTaskMutation.mutate()
            }
        },
        onError: onErrorDialog('Copy', 'Failed to start copy', {
            capture: false,
            log: ['Error starting copy:'],
        }),
    })

    const scheduleTaskMutation = useScheduleTask({
        operation: 'copy',
        cronExpression,
        validate: () => {
            if (!sources || sources.length === 0 || !dest) {
                throw new Error('Please select both a source and destination path')
            }

            if (sources.length > 1 && !usePersistedStore.getState().licenseValid) {
                throw new Error('You need a valid license to schedule multiple tasks at once')
            }
        },
        buildArgs,
    })

    const dryRunMutation = useOperationDryRun(async () => {
        if (!sources || sources.length === 0 || !dest) {
            throw new Error('Please select both a source and destination path')
        }
        return startDryRun((isDryRun) =>
            startCopy(
                {
                    sources,
                    destination: dest,
                    options: {
                        config: { ...configGroup.options, dry_run: true },
                        copy: copyGroup.options,
                        filter: filterGroup.options,
                        remotes: remotesGroup.options,
                    },
                },
                isDryRun
            )
        )
    })

    const buttonText = useMemo(() => {
        if (startCopyMutation.isPending) return 'STARTING...'
        if (!sources || sources.length === 0) return 'Please select a source path'
        if (!dest) return 'Please select a destination path'
        if (sources.some((s) => s === dest)) return 'Source and destination cannot be the same'
        if (jsonError) return 'Invalid JSON for ' + jsonError.toUpperCase() + ' options'
        if (cronExpression) return 'START AND SCHEDULE COPY'
        return 'START COPY'
    }, [startCopyMutation.isPending, sources, dest, jsonError, cronExpression])

    const buttonIcon = useMemo(() => {
        if (startCopyMutation.isPending) return
        if (!sources || sources.length === 0 || !dest || sources.some((s) => s === dest))
            return <FoldersIcon className="w-5 h-5" />
        if (jsonError) return <AlertOctagonIcon className="w-5 h-5" />
        return <PlayIcon className="w-5 h-5 fill-current" />
    }, [startCopyMutation.isPending, sources, dest, jsonError])

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
            selectedRemotes,
            cronExpression,
            schedulingAvailable,
        ]
    )

    const handleStart = useCallback(() => startCopyMutation.mutate(), [startCopyMutation.mutate])

    const handleSchedule = useCallback(
        () => scheduleTaskMutation.mutate(),
        [scheduleTaskMutation.mutate]
    )

    const handleDryRun = useCallback(() => dryRunMutation.mutate(), [dryRunMutation.mutate])

    const handleResetPaths = useCallback(() => {
        startTransition(() => {
            setSources(undefined)
            setDest(undefined)
            setJsonError(null)
            startCopyMutation.reset()
        })
    }, [setJsonError, startCopyMutation.reset])

    const handleResetOptions = useCallback(() => {
        startTransition(() => {
            resetJson()
            setCronExpression(null)
            startCopyMutation.reset()
        })
    }, [resetJson, startCopyMutation.reset])

    const handleResetAll = useCallback(() => {
        startTransition(() => {
            resetJson()
            resetLocks()
            setCronExpression(null)
            setSources(undefined)
            setDest(undefined)
            startCopyMutation.reset()
        })
    }, [resetJson, resetLocks, startCopyMutation.reset])

    useEffect(() => {
        console.log('[Copy] remoteOptions', remotesGroup.options)
        console.log('[Copy] remoteOptionsJson', remotesGroup.json)
    }, [remotesGroup.json, remotesGroup.options])

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
                    operation="copy"
                    templatesDisabled={!!jsonError}
                    onTemplateSelect={applyTemplate}
                    getTemplateOptions={getMergedOptions}
                    startIsSuccess={startCopyMutation.isSuccess}
                    startIsPending={startCopyMutation.isPending}
                    onStart={handleStart}
                    onSchedule={handleSchedule}
                    dryRunIsPending={dryRunMutation.isPending}
                    onDryRun={handleDryRun}
                    startBlocked={
                        !!jsonError ||
                        !sources ||
                        sources.length === 0 ||
                        !dest ||
                        sources.some((s) => s === dest)
                    }
                    buttonText={buttonText}
                    buttonIcon={buttonIcon}
                    newLabel="NEW COPY"
                    onResetPaths={handleResetPaths}
                    onResetOptions={handleResetOptions}
                    onResetAll={handleResetAll}
                    helpContent={HELP_CONTENT}
                />
            </OperationWindowFooter>
        </div>
    )
}
