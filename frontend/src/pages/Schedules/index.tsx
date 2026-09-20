import { Card, CardBody, CardHeader, Tooltip } from '@heroui/react'
import { Button, Chip } from '@heroui/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import cronstrue from 'cronstrue'
import { formatDistance } from 'date-fns'
import {
    AlertCircleIcon,
    Clock7Icon,
    ClockIcon,
    PauseIcon,
    PlayIcon,
    Trash2Icon,
    ZapIcon,
} from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { onErrorDialog } from '@/lib/errors'
import { buildReadablePath } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import {
    type Schedule,
    SCHEDULES_KEY,
    removeSchedule,
    schedulerRunNow,
    setScheduleEnabled,
    useSchedules,
} from '@/lib/scheduler'
import EmptyState from '@/components/EmptyState'
import ScheduleEditDrawer from './ScheduleEditDrawer'
import { ask } from '@/dialog'

export default function Schedules() {
    const schedulesQuery = useSchedules()
    const schedules = useMemo(() => schedulesQuery.data ?? [], [schedulesQuery.data])

    // The edit drawer is a route (`/schedules/<id>`: a run's transfer links here), read from the
    // list as it refreshes (a run starts, the next fire times move), so the drawer follows the
    // schedule and not a snapshot of it. Closing is going back to the list.
    const navigate = useNavigate()
    const { id: selectedId } = useParams<{ id?: string }>()
    const selectedTask = schedules.find((schedule) => schedule.id === selectedId) ?? null
    const handleOpenDrawer = useCallback(
        (task: Schedule) => navigate(`/schedules/${task.id}`),
        [navigate]
    )
    const onClose = useCallback(() => navigate('/schedules'), [navigate])

    // Nothing until the list has been read once: an empty state that flashes before it is a lie.
    if (schedulesQuery.isPending) return null

    if (schedules.length === 0) {
        return (
            <div className="w-full h-full overflow-y-auto">
                <EmptyState
                    icon={ClockIcon}
                    title="Nothing scheduled yet"
                    description="Set up a copy, move, sync, bisync, delete or purge, then schedule it from its window. The server runs them on its own, with nobody looking, and each run shows up in Transfers."
                />
            </div>
        )
    }

    return (
        <div className="flex flex-col h-full overflow-scroll">
            {schedules.map((task) => (
                <TaskCard key={task.id} task={task} onOpenDrawer={handleOpenDrawer} />
            ))}
            {selectedTask && (
                <ScheduleEditDrawer isOpen={true} onClose={onClose} selectedTask={selectedTask} />
            )}
        </div>
    )
}

function TaskCard({
    task,
    onOpenDrawer,
}: {
    task: Schedule
    onOpenDrawer: (task: Schedule) => void
}) {
    const queryClient = useQueryClient()

    // The card's time-derived values are anchored to this tick — without it the memos freeze at
    // their last dep change (e.g. a past occurrence kept showing as the "next run" forever).
    const now = useNow()

    // The next fire times come with the list, from Rust (the very matcher the tick uses): JS
    // cron libraries disagree with real cron on dom/dow star semantics, so computing them here
    // could predict fires that will never happen. The first still in the future is the label.
    const nextRun = useMemo(
        () => task.nextRuns.map((run) => new Date(run)).find((run) => run.getTime() > now) ?? null,
        [task.nextRuns, now]
    )

    const source = useMemo(
        () => ('source' in task.args ? task.args.source : task.args.sources[0]),
        [task.args]
    )

    const nextRunLabel = useMemo(() => {
        if (!task.isEnabled) {
            return 'Paused'
        }
        if (nextRun) {
            const distance = formatDistance(nextRun, new Date(now), { addSuffix: true })
            return distance.charAt(0).toUpperCase() + distance.slice(1)
        }
        return 'Never'
    }, [nextRun, now, task.isEnabled])

    const isRunning = task.running
    const lastFinished = task.lastFinished

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

    const invalidateScheduler = () => queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY })

    const runNowMutation = useMutation({
        mutationFn: () => schedulerRunNow(task.id),
        onSuccess: invalidateScheduler,
        onError: onErrorDialog('Run now', 'Failed to start the task'),
    })

    const toggleMutation = useMutation({
        mutationFn: async () => {
            if (task.isEnabled) {
                const answer = await ask('Are you sure you want to disable this task?')
                if (!answer) {
                    return
                }
                await setScheduleEnabled(task.id, false)
            } else {
                await setScheduleEnabled(task.id, true)
            }
        },
        onSuccess: invalidateScheduler,
        onError: onErrorDialog('Schedule', 'Failed to update the task'),
    })

    const removeMutation = useMutation({
        mutationFn: async () => {
            const answer = await ask('Are you sure you want to remove this task?')
            if (!answer) {
                return
            }
            await removeSchedule(task.id)
        },
        onSuccess: invalidateScheduler,
        onError: onErrorDialog('Schedule', 'Failed to remove the task'),
    })

    const errorLine =
        !isRunning && lastFinished && !lastFinished.success
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
                                    color={task.isEnabled ? 'primary' : 'default'}
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
                                isDisabled={!task.isEnabled || isRunning || runNowMutation.isPending}
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
                            isDisabled={toggleMutation.isPending}
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
