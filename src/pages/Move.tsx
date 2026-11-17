import { Switch } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { AlertOctagonIcon, FoldersIcon, PlayIcon } from 'lucide-react'
import { startTransition, useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { onErrorDialog } from '../../lib/errors'
import { getOptionsSubtitle } from '../../lib/flags'
import { useFlags } from '../../lib/hooks'
import { startDryRun, startMove } from '../../lib/rclone/api'
import { RCLONE_CONFIG_DEFAULTS } from '../../lib/rclone/constants'
import type { MoveOuterOptions } from '../../lib/rclone/requests'
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

• Move — The switches at the top control empty directories when moving a folder (they don't apply to single files, or when rclone moves the whole folder server-side because the destination doesn't exist yet):
   • createEmptySrcDirs — Recreate empty source directories on the destination. On by default.
   • deleteEmptySrcDirs — Remove source directories left empty after the move. Off by default.
Below the switches: multi-threading settings (multi_thread_cutoff, streams, chunk_size), checksum verification, how to handle existing files (ignore_existing), and metadata preservation.

• Filters — Include or exclude files by pattern, limit by size (max_size, min_size) or age (max_age, min_age).

• Cron — Schedule this move to run automatically at set intervals. It runs even when the app is closed.

• Config — Performance tuning: parallel transfers, checkers, buffer_size, bandwidth limits (bwlimit), and fast_list for faster directory listings on supported remotes.

• Remotes — Override backend-specific settings for remotes involved in this operation.

3. USE TEMPLATES (Optional)
Tap the folder icon in the bottom bar to load or save option presets. Templates let you quickly apply common configurations without manually setting each option.

4. START THE MOVE
Once paths are selected, tap "START MOVE" to begin. You can monitor progress on the Transfers page.`

export default function Move() {
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
            { key: 'move', templateKey: 'copy', defaults: RCLONE_CONFIG_DEFAULTS.copy },
            { key: 'filter' },
            { key: 'config', defaults: RCLONE_CONFIG_DEFAULTS.config },
        ],
        withRemotes: true,
    })
    const moveGroup = optionGroups.move
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config

    const [outerMoveOptions, setOuterMoveOptions] = useState<MoveOuterOptions>({})

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
            move: moveGroup.options,
            filter: filterGroup.options,
            remotes: remotesGroup.options,
            outer: outerMoveOptions,
        },
    })

    const startMoveMutation = useMutation({
        mutationFn: async () => {
            if (!sources || sources.length === 0 || !dest) {
                throw new Error('Please select both a source and destination path')
            }

            return startMove(buildArgs())
        },
        onSuccess: () => {
            if (cronExpression) {
                scheduleTaskMutation.mutate()
            }
        },
        onError: onErrorDialog('Move', 'Failed to start move', {
            capture: false,
            log: ['Error starting move:'],
        }),
    })

    const scheduleTaskMutation = useScheduleTask({
        operation: 'move',
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
            startMove(
                {
                    sources,
                    destination: dest,
                    options: {
                        config: { ...configGroup.options, dry_run: true },
                        move: moveGroup.options,
                        filter: filterGroup.options,
                        remotes: remotesGroup.options,
                        outer: outerMoveOptions,
                    },
                },
                isDryRun
            )
        )
    })

    const buttonText = useMemo(() => {
        if (startMoveMutation.isPending) return 'STARTING...'
        if (!sources || sources.length === 0) return 'Please select a source path'
        if (!dest) return 'Please select a destination path'
        if (sources.some((s) => s === dest)) return 'Source and destination cannot be the same'
        if (jsonError) return 'Invalid JSON for ' + jsonError.toUpperCase() + ' options'
        if (cronExpression) return 'START AND SCHEDULE MOVE'
        return 'START MOVE'
    }, [startMoveMutation.isPending, sources, dest, jsonError, cronExpression])

    const buttonIcon = useMemo(() => {
        if (startMoveMutation.isPending) return
        if (!sources || sources.length === 0 || !dest || sources.some((s) => s === dest))
            return <FoldersIcon className="w-5 h-5" />
        if (jsonError) return <AlertOctagonIcon className="w-5 h-5" />
        return <PlayIcon className="w-5 h-5 fill-current" />
    }, [startMoveMutation.isPending, sources, dest, jsonError])

    const accordionItems = useMemo<OptionsAccordionItemDef[]>(
        () => [
            {
                key: 'move',
                category: 'move',
                subtitle: getOptionsSubtitle(Object.keys(moveGroup.options).length),
                children: (
                    <>
                        <div className="flex flex-row flex-wrap gap-2 pb-5">
                            <Switch
                                isSelected={outerMoveOptions.createEmptySrcDirs ?? true}
                                onValueChange={(value) =>
                                    setOuterMoveOptions((prev) => ({
                                        ...prev,
                                        createEmptySrcDirs: value,
                                    }))
                                }
                                size="sm"
                            >
                                createEmptySrcDirs
                            </Switch>

                            <Switch
                                isSelected={!!outerMoveOptions.deleteEmptySrcDirs}
                                onValueChange={(value) =>
                                    setOuterMoveOptions((prev) => ({
                                        ...prev,
                                        deleteEmptySrcDirs: value,
                                    }))
                                }
                                size="sm"
                            >
                                deleteEmptySrcDirs
                            </Switch>
                        </div>
                        <OptionsSection
                            globalOptions={globalFlags?.main || {}}
                            optionsJson={moveGroup.jsonString}
                            setOptionsJson={moveGroup.setJsonString}
                            availableOptions={copyFlags || []}
                            isLocked={moveGroup.locked}
                            setIsLocked={moveGroup.setLocked}
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
            outerMoveOptions,
            filterGroup,
            configGroup,
            remotesGroup,
            globalFlags,
            filterFlags,
            configFlags,
            copyFlags,
            selectedRemotes,
            cronExpression,
            schedulingAvailable,
        ]
    )

    const handleStart = useCallback(() => startMoveMutation.mutate(), [startMoveMutation.mutate])

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
            startMoveMutation.reset()
        })
    }, [setJsonError, startMoveMutation.reset])

    const handleResetOptions = useCallback(() => {
        startTransition(() => {
            resetJson()
            setOuterMoveOptions({})
            setCronExpression(null)
            startMoveMutation.reset()
        })
    }, [resetJson, startMoveMutation.reset])

    const handleResetAll = useCallback(() => {
        startTransition(() => {
            resetJson()
            resetLocks()
            setOuterMoveOptions({})
            setCronExpression(null)
            setSources(undefined)
            setDest(undefined)
            startMoveMutation.reset()
        })
    }, [resetJson, resetLocks, startMoveMutation.reset])

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
                    templatesDisabled={!!jsonError}
                    onTemplateSelect={applyTemplate}
                    getTemplateOptions={getMergedOptions}
                    startIsSuccess={startMoveMutation.isSuccess}
                    startIsPending={startMoveMutation.isPending}
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
                    newLabel="NEW MOVE"
                    onResetPaths={handleResetPaths}
                    onResetOptions={handleResetOptions}
                    onResetAll={handleResetAll}
                    helpContent={HELP_CONTENT}
                />
            </OperationWindowFooter>
        </div>
    )
}
