import { Alert } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { AlertOctagonIcon, FoldersIcon, PlayIcon } from 'lucide-react'
import { startTransition, useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { onErrorDialog } from '../../lib/errors'
import { getOptionsSubtitle } from '../../lib/flags'
import { getRemoteName } from '../../lib/format'
import { hasFeature, useFlags, useFsInfo } from '../../lib/hooks'
import { notify } from '../../lib/notifications'
import { startDelete, startDryRun } from '../../lib/rclone/api'
import { RCLONE_CONFIG_DEFAULTS } from '../../lib/rclone/constants'
import { useSchedulingAvailable } from '../../lib/scheduler'
import OperationWindowContent from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import OptionsSection from '../components/OptionsSection'
import { PathField } from '../components/PathFinder'
import CronSection from '../components/operation/CronSection'
import OperationFooter from '../components/operation/OperationFooter'
import OptionsAccordion, {
    type OptionsAccordionItemDef,
} from '../components/operation/OptionsAccordion'
import { useOperationDryRun } from '../components/operation/useOperationDryRun'
import { useOptionGroups } from '../components/operation/useOptionGroups'
import { useScheduleTask } from '../components/operation/useScheduleTask'

const PATH_ALLOWED_KEYS: ('LOCAL_FS' | 'FAVORITES' | 'REMOTES')[] = ['REMOTES', 'FAVORITES']

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

• Cron — Schedule this delete to run automatically at set intervals. Useful for automated cleanup tasks. It runs even when the app is closed.

3. USE TEMPLATES (Optional)
Tap the folder icon in the bottom bar to load or save option presets. Templates let you quickly apply common filter configurations for recurring cleanup tasks.

4. START THE DELETE
Once a path is selected, tap "START DELETE" to begin. The operation will delete all files matching your filters (or all files if no filters are set). Empty directories will be left behind unless you use the rmdirs option.`

export default function Delete() {
    const [searchParams] = useSearchParams()
    const { globalFlags, filterFlags, configFlags } = useFlags()

    const [sourceFs, setSourceFs] = useState<string | undefined>(
        searchParams.get('initialSource') ? searchParams.get('initialSource')! : undefined
    )

    const [cronExpression, setCronExpression] = useState<string | null>(null)
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
        groups: [{ key: 'filter' }, { key: 'config', defaults: RCLONE_CONFIG_DEFAULTS.config }],
    })
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config

    const sourceRemoteName = useMemo(() => getRemoteName(sourceFs), [sourceFs])

    const sourceFsInfoQuery = useFsInfo(sourceRemoteName)

    // false while loading — matches the previous default (offer the plain delete until purge is confirmed).
    const supportsPurge = useMemo(
        () => hasFeature(sourceFsInfoQuery.data, 'Purge'),
        [sourceFsInfoQuery.data]
    )

    const buildArgs = () => ({
        sources: [sourceFs!],
        options: {
            filter: filterGroup.options,
            config: configGroup.options,
        },
    })

    const startDeleteMutation = useMutation({
        mutationFn: async () => {
            if (!sourceFs) {
                throw new Error('Please select a source path to delete')
            }

            return startDelete(buildArgs())
        },
        onSuccess: async () => {
            await notify({
                title: 'Success',
                body: 'Delete task started',
            })
            if (cronExpression) {
                scheduleTaskMutation.mutate()
            }
        },
        onError: onErrorDialog('Delete', 'Failed to start delete', {
            log: ['Error starting delete:'],
        }),
    })

    const scheduleTaskMutation = useScheduleTask({
        operation: 'delete',
        cronExpression,
        validate: () => {
            if (!sourceFs) {
                throw new Error('Please select a source path to delete')
            }
        },
        buildArgs,
    })

    const dryRunMutation = useOperationDryRun(async () => {
        if (!sourceFs) {
            throw new Error('Please select a source path to delete')
        }
        return startDryRun((isDryRun) =>
            startDelete(
                {
                    sources: [sourceFs],
                    options: {
                        filter: filterGroup.options,
                        config: { ...configGroup.options, dry_run: true },
                    },
                },
                isDryRun
            )
        )
    })

    const buttonText = useMemo(() => {
        if (startDeleteMutation.isPending) return 'STARTING...'
        if (!sourceFs || sourceFs.length === 0) return 'Please select a source path'
        if (jsonError) return 'Invalid JSON for ' + jsonError.toUpperCase() + ' options'
        if (cronExpression) return 'START AND SCHEDULE DELETE'
        return 'START DELETE'
    }, [startDeleteMutation.isPending, sourceFs, jsonError, cronExpression])

    const buttonIcon = useMemo(() => {
        if (startDeleteMutation.isPending) return
        if (!sourceFs || sourceFs.length === 0) return <FoldersIcon className="w-5 h-5" />
        if (jsonError) return <AlertOctagonIcon className="w-5 h-5" />
        return <PlayIcon className="w-5 h-5 fill-current" />
    }, [startDeleteMutation.isPending, sourceFs, jsonError])

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
            cronExpression,
            schedulingAvailable,
        ]
    )

    const handleStart = useCallback(
        () => startDeleteMutation.mutate(),
        [startDeleteMutation.mutate]
    )

    const handleSchedule = useCallback(
        () => scheduleTaskMutation.mutate(),
        [scheduleTaskMutation.mutate]
    )

    const handleDryRun = useCallback(() => dryRunMutation.mutate(), [dryRunMutation.mutate])

    const handleResetPaths = useCallback(() => {
        startTransition(() => {
            setSourceFs(undefined)
            setJsonError(null)
            startDeleteMutation.reset()
        })
    }, [setJsonError, startDeleteMutation.reset])

    const handleResetOptions = useCallback(() => {
        startTransition(() => {
            resetJson()
            setCronExpression(null)
            startDeleteMutation.reset()
        })
    }, [resetJson, startDeleteMutation.reset])

    const handleResetAll = useCallback(() => {
        startTransition(() => {
            resetJson()
            resetLocks()
            setCronExpression(null)
            setSourceFs(undefined)
            startDeleteMutation.reset()
        })
    }, [resetJson, resetLocks, startDeleteMutation.reset])

    return (
        <div className="flex flex-col h-screen gap-10">
            {/* Main Content */}
            <OperationWindowContent>
                {/* Path Display */}
                <PathField
                    path={sourceFs || ''}
                    setPath={setSourceFs}
                    label="Path"
                    placeholder="Enter a remote:/path to delete"
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
                    templatesDisabled={!!jsonError}
                    onTemplateSelect={applyTemplate}
                    getTemplateOptions={getMergedOptions}
                    startIsSuccess={startDeleteMutation.isSuccess}
                    startIsPending={startDeleteMutation.isPending}
                    onStart={handleStart}
                    onSchedule={handleSchedule}
                    dryRunIsPending={dryRunMutation.isPending}
                    onDryRun={handleDryRun}
                    startBlocked={!!jsonError || !sourceFs || sourceFs.length === 0}
                    buttonText={buttonText}
                    buttonIcon={buttonIcon}
                    newLabel="NEW DELETE"
                    showViewTransfers={false}
                    resetPathsLabel="Reset Path"
                    onResetPaths={handleResetPaths}
                    onResetOptions={handleResetOptions}
                    onResetAll={handleResetAll}
                    helpContent={HELP_CONTENT}
                />
            </OperationWindowFooter>
        </div>
    )
}
