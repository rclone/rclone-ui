import { Alert, Card, CardBody, CardHeader, Tooltip, useDisclosure } from '@heroui/react'
import { Button, Chip } from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ask } from '@tauri-apps/plugin-dialog'
import { platform } from '@tauri-apps/plugin-os'
import cronstrue from 'cronstrue'
import { formatDistance } from 'date-fns'
import { AlertCircleIcon, Clock7Icon, PauseIcon, PlayIcon, Trash2Icon, ZapIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { onErrorDialog } from '../../lib/errors'
import { buildReadablePath } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { LOCAL_HOST_ID } from '../../lib/hosts'
import {
    type SchedulerTaskStatus,
    removeScheduledTask as schedulerRemoveTask,
    schedulerRunNow,
    schedulerStatus,
    schedulerValidateCron,
    setScheduledTaskEnabled,
    useSchedulerSupported,
} from '../../lib/scheduler'
import { useHostStore } from '../../store/host'
import { usePersistedStore } from '../../store/persisted'
import type { ScheduledTask } from '../../types/schedules'
import CommandsDropdown from '../components/CommandsDropdown'
import ScheduleEditDrawer from '../components/ScheduleEditDrawer'

export default function Schedules() {
    const scheduledTasks = useHostStore((state) => state.scheduledTasks)
    const currentHostId = usePersistedStore((state) => state.currentHostId) ?? LOCAL_HOST_ID
    const isLocalHost = currentHostId === LOCAL_HOST_ID

    const supportQuery = useSchedulerSupported()
    const schedulingAvailable = isLocalHost && (supportQuery.data?.supported ?? false)

    const unavailableReason = isLocalHost
        ? (supportQuery.data?.reason ?? 'Scheduling is not available on this system.')
        : 'Scheduling runs on your local machine only — switch to the local host to manage these tasks.'

    const [selectedTask, setSelectedTask] = useState<ScheduledTask | null>(null)
    const { isOpen, onOpen, onClose } = useDisclosure()

    const statusQuery = useQuery({
        queryKey: ['scheduler', 'status'],
        queryFn: () => schedulerStatus(LOCAL_HOST_ID),
        enabled: schedulingAvailable,
        refetchInterval: 5_000,
        refetchOnWindowFocus: true,
    })

    const statusMap = useMemo(
        () => new Map((statusQuery.data ?? []).map((status) => [status.taskId, status])),
        [statusQuery.data]
    )

    const handleOpenDrawer = useCallback(
        (task: ScheduledTask) => {
            setSelectedTask(task)
            onOpen()
        },
        [onOpen]
    )

    if (scheduledTasks.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-screen gap-8">
                <h1 className="max-w-md text-2xl font-bold text-center">
                    {schedulingAvailable || supportQuery.isLoading
                        ? 'You can schedule tasks to run automatically, even while the app is closed.'
                        : unavailableReason}
                </h1>
                {schedulingAvailable && <CommandsDropdown title="New scheduled task" />}
            </div>
        )
    }

    return (
        <div className="flex flex-col h-screen overflow-scroll">
            {platform() === 'macos' && (
                <div className="w-full h-10 border-b bg-content1 border-divider" />
            )}
            {!schedulingAvailable && !supportQuery.isLoading && (
                <Alert
                    color="warning"
                    title={unavailableReason}
                    radius="none"
                    classNames={{ base: 'flex-shrink-0' }}
                />
            )}
            {scheduledTasks.map((task) => (
                <TaskCard
                    key={task.id}
                    task={task}
                    status={statusMap.get(task.id)}
                    schedulingAvailable={schedulingAvailable}
                    onOpenDrawer={handleOpenDrawer}
                />
            ))}
            {selectedTask && (
                <ScheduleEditDrawer isOpen={isOpen} onClose={onClose} selectedTask={selectedTask} />
            )}
        </div>
    )
}

function TaskCard({
    task,
    status,
    schedulingAvailable,
    onOpenDrawer,
}: {
    task: ScheduledTask
    status?: SchedulerTaskStatus
    schedulingAvailable: boolean
    onOpenDrawer: (task: ScheduledTask) => void
}) {
    const queryClient = useQueryClient()

    // The card's time-derived values are anchored to this tick — without it the memos freeze at
    // their last dep change (e.g. a past occurrence kept showing as the "next run" forever).
    const now = useNow()

    // Next-run preview comes from Rust (the runner's own cron matcher) — JS cron libraries
    // disagree with real cron on dom/dow star semantics, so computing it here could predict
    // fires the native schedule never performs. The query returns the next 5; the memo picks
    // the first still in the future so the label stays fresh between refetches.
    const nextRunsQuery = useQuery({
        queryKey: ['scheduler', 'validate-cron', task.cron],
        queryFn: () => schedulerValidateCron(task.cron),
        refetchInterval: 60_000,
    })
    const nextRun = useMemo(() => {
        const upcoming = nextRunsQuery.data?.nextRuns ?? []
        return upcoming.map((run) => new Date(run)).find((run) => run.getTime() > now) ?? null
    }, [nextRunsQuery.data, now])

    const source = useMemo(
        () => ('source' in task.args ? task.args.source : task.args.sources[0]),
        [task.args]
    )

    const nextRunLabel = useMemo(() => {
        if (!task.isEnabled || !schedulingAvailable) {
            return 'Paused'
        }
        if (nextRun) {
            const distance = formatDistance(nextRun, new Date(now), { addSuffix: true })
            return distance.charAt(0).toUpperCase() + distance.slice(1)
        }
        return 'Never'
    }, [nextRun, now, task.isEnabled, schedulingAvailable])

    const isRunning = status?.running ?? false
    const lastFinished = status?.lastFinished

    const lastRunLabel = useMemo(() => {
        if (isRunning) {
            return 'Running now'
        }
        if (lastFinished) {
            const distance = formatDistance(new Date(lastFinished.ts), new Date(now), {
                addSuffix: true,
            })
            return distance.charAt(0).toUpperCase() + distance.slice(1)
        }
        return 'Never'
    }, [isRunning, lastFinished, now])

    const invalidateScheduler = () => queryClient.invalidateQueries({ queryKey: ['scheduler'] })

    const runNowMutation = useMutation({
        mutationFn: () => schedulerRunNow(task.id),
        onSuccess: invalidateScheduler,
        onError: onErrorDialog('Run now', 'Failed to start the task', { capture: false }),
    })

    const toggleMutation = useMutation({
        mutationFn: async () => {
            if (task.isEnabled) {
                const answer = await ask('Are you sure you want to disable this task?')
                if (!answer) {
                    return
                }
                await setScheduledTaskEnabled(task.id, false)
            } else {
                await setScheduledTaskEnabled(task.id, true)
            }
        },
        onSuccess: invalidateScheduler,
        onError: onErrorDialog('Schedule', 'Failed to update the task', { capture: false }),
    })

    const removeMutation = useMutation({
        mutationFn: async () => {
            const answer = await ask('Are you sure you want to remove this task?')
            if (!answer) {
                return
            }
            await schedulerRemoveTask(task.id)
        },
        onSuccess: invalidateScheduler,
        onError: onErrorDialog('Schedule', 'Failed to remove the task', { capture: false }),
    })

    const errorLine = task.registrationError
        ? `Not scheduled: ${task.registrationError}`
        : status?.warning
          ? status.warning
          : !isRunning && lastFinished && !lastFinished.success
            ? lastFinished.error || 'The last run failed'
            : null

    return (
        <Card
            key={task.id}
            radius="none"
            shadow="none"
            isPressable={true}
            onPress={() => onOpenDrawer(task)}
            style={{
                flexShrink: 0,
            }}
            className="p-2 border-b border-divider"
        >
            <CardHeader>
                {/* The name column is the only one allowed to shrink (it truncates);
                    the run chips and action buttons keep their natural width so the
                    buttons stay pinned to the right edge whatever the labels say. */}
                <div className="flex flex-row items-start justify-between w-full h-10 gap-4">
                    <div className="flex flex-row justify-start flex-1 min-w-0 gap-2">
                        <Chip
                            isCloseable={false}
                            size="lg"
                            variant="flat"
                            radius="sm"
                            color={
                                task.operation === 'delete'
                                    ? 'danger'
                                    : task.operation === 'copy'
                                      ? 'success'
                                      : 'primary'
                            }
                            className="h-10"
                        >
                            {task.operation.toUpperCase()}
                        </Chip>
                        {task.runMode === 'system' && (
                            <Tooltip
                                content="Runs even while logged out — without your session's keychain, mounted drives, or (on macOS) protected folders"
                                placement="bottom"
                                size="lg"
                                color="foreground"
                            >
                                <Chip
                                    isCloseable={false}
                                    size="lg"
                                    variant="flat"
                                    radius="sm"
                                    color="secondary"
                                    className="h-10"
                                >
                                    SYSTEM
                                </Chip>
                            </Tooltip>
                        )}
                        <div className="flex flex-col gap-0 min-w-0">
                            <p className="max-w-64 text-sm font-bold truncate text-start">
                                {task.name || 'Untitled Schedule'}
                            </p>
                            <div className="text-sm text-gray-500 text-start truncate">
                                {buildReadablePath(source, 'short')} {'→'}{' '}
                                {'destination' in task.args
                                    ? buildReadablePath(task.args.destination, 'short')
                                    : 'N/A'}
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-row justify-center gap-2 shrink-0">
                        <div className="flex flex-col items-center justify-center gap-0.5">
                            <Tooltip
                                content={
                                    isRunning
                                        ? undefined
                                        : lastFinished
                                          ? new Date(lastFinished.ts).toLocaleDateString('en-US', {
                                                month: 'short',
                                                day: 'numeric',
                                                weekday: 'short',
                                                hour: '2-digit',
                                                minute: '2-digit',
                                                second: '2-digit',
                                            })
                                          : "This task hasn't run yet"
                                }
                                placement="bottom"
                                size="lg"
                                color="foreground"
                                isDisabled={isRunning}
                            >
                                <Chip
                                    isCloseable={false}
                                    size="lg"
                                    variant="flat"
                                    radius="sm"
                                    color={
                                        isRunning
                                            ? 'success'
                                            : lastFinished && !lastFinished.success
                                              ? 'danger'
                                              : 'default'
                                    }
                                >
                                    {lastRunLabel}
                                </Chip>
                            </Tooltip>
                            <p className="text-xs text-gray-500">Last run</p>
                        </div>
                        <div className="flex flex-col items-center justify-center gap-0.5">
                            <Tooltip
                                content={nextRun?.toLocaleDateString('en-US', {
                                    month: 'short',
                                    day: 'numeric',
                                    weekday: 'short',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                })}
                                placement="bottom"
                                size="lg"
                                color="foreground"
                            >
                                <Chip
                                    isCloseable={false}
                                    size="lg"
                                    variant="flat"
                                    radius="sm"
                                    color={
                                        task.isEnabled && schedulingAvailable
                                            ? 'primary'
                                            : 'default'
                                    }
                                >
                                    {nextRunLabel}
                                </Chip>
                            </Tooltip>
                            <p className="text-xs text-gray-500">Next run</p>
                        </div>
                    </div>
                    <div className="flex flex-row justify-end gap-2 shrink-0">
                        <Tooltip content="Run now" placement="bottom" size="lg" color="foreground">
                            <Button
                                isIconOnly={true}
                                color="success"
                                variant="flat"
                                isDisabled={
                                    !schedulingAvailable ||
                                    !task.isEnabled ||
                                    isRunning ||
                                    runNowMutation.isPending
                                }
                                size="sm"
                                onPress={() => runNowMutation.mutate()}
                                data-focus-visible="false"
                            >
                                <ZapIcon className="w-4 h-4" />
                            </Button>
                        </Tooltip>
                        <Button
                            isIconOnly={true}
                            color={task.isEnabled ? 'primary' : 'warning'}
                            isDisabled={!schedulingAvailable || toggleMutation.isPending}
                            size="sm"
                            onPress={() => toggleMutation.mutate()}
                            data-focus-visible="false"
                        >
                            {task.isEnabled ? (
                                <PauseIcon className="w-4 h-4" />
                            ) : (
                                <PlayIcon className="w-4 h-4" />
                            )}
                        </Button>
                        <Button
                            isIconOnly={true}
                            color="danger"
                            isDisabled={removeMutation.isPending}
                            size="sm"
                            onPress={() => removeMutation.mutate()}
                            data-focus-visible="false"
                        >
                            <Trash2Icon className="w-4 h-4" />
                        </Button>
                    </div>
                </div>
            </CardHeader>
            <CardBody>
                <div className="flex flex-row items-center justify-start gap-1 text-sm font-bold">
                    {errorLine ? (
                        <>
                            <AlertCircleIcon className="w-4 h-4 text-danger-600" />
                            <p className="text-sm font-bold text-danger-600">{errorLine}</p>
                        </>
                    ) : (
                        <>
                            <Clock7Icon className="w-4 h-4" />
                            <p className="text-sm font-bold truncate">
                                {safeCronDescription(task.cron)}
                            </p>
                        </>
                    )}
                </div>
            </CardBody>
        </Card>
    )
}

function safeCronDescription(cron: string) {
    try {
        return `${cronstrue.toString(cron)}.`
    } catch {
        return cron
    }
}
