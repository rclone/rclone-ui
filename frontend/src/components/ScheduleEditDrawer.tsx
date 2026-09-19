import {
    Alert,
    Button,
    Chip,
    Divider,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Input,
    ScrollShadow,
    Switch,
    Tooltip,
    cn,
} from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { format, formatDistance } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatErrorMessage } from '../../lib/errors'
import { buildReadablePath } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import {
    DEFAULT_MAX_RUN_HOURS,
    MAX_RUN_HOURS_LIMIT,
    schedulerReadHistory,
    schedulerReadLog,
    updateScheduledTask as schedulerUpdateTask,
    schedulerValidateCron,
} from '../../lib/scheduler'
import type { ScheduledTask } from '../../types/schedules'
import CronEditor from './CronEditor'

export default function ScheduleEditDrawer({
    isOpen,
    onClose,
    selectedTask,
}: {
    isOpen: boolean
    onClose: () => void
    selectedTask: ScheduledTask
}) {
    const queryClient = useQueryClient()
    const navigate = useNavigate()

    const [name, setName] = useState(selectedTask.name ?? '')
    const [cronExpression, setCronExpression] = useState(selectedTask.cron)
    const [isEnabled, setIsEnabled] = useState(selectedTask.isEnabled)
    const [maxRunHours, setMaxRunHours] = useState(
        String(selectedTask.maxRunHours ?? DEFAULT_MAX_RUN_HOURS)
    )
    const [saveError, setSaveError] = useState<string | null>(null)

    useEffect(() => {
        if (isOpen) {
            setName(selectedTask.name ?? '')
            setCronExpression(selectedTask.cron)
            setIsEnabled(selectedTask.isEnabled)
            setMaxRunHours(String(selectedTask.maxRunHours ?? DEFAULT_MAX_RUN_HOURS))
            setSaveError(null)
        }
    }, [isOpen, selectedTask])

    const maxRunHoursNumber = Number(maxRunHours)
    const maxRunHoursInvalid =
        !Number.isInteger(maxRunHoursNumber) ||
        maxRunHoursNumber < 1 ||
        maxRunHoursNumber > MAX_RUN_HOURS_LIMIT

    const source = useMemo(
        () =>
            'source' in selectedTask.args ? selectedTask.args.source : selectedTask.args.sources[0],
        [selectedTask.args]
    )

    const destination = useMemo(
        () => ('destination' in selectedTask.args ? selectedTask.args.destination : null),
        [selectedTask.args]
    )

    // The drawer stays mounted after close, so "the next 5 runs" must be re-anchored to the
    // current time on every open (and kept fresh while open) — paused while closed.
    const now = useNow(isOpen ? 30_000 : null)

    const cronValidation = useQuery({
        queryKey: ['scheduler', 'validate-cron', cronExpression],
        queryFn: () => schedulerValidateCron(cronExpression),
        enabled: isOpen && !!cronExpression,
        // The response carries the next-runs preview anchored at fetch time; without refetching,
        // a frequent schedule (e.g. every minute) drains all 5 entries past `now` while the
        // drawer sits open.
        refetchInterval: 30_000,
    })
    const cronError =
        cronValidation.data && !cronValidation.data.valid
            ? (cronValidation.data.error ?? 'Invalid cron expression')
            : null

    const historyQuery = useQuery({
        queryKey: ['scheduler', 'history', selectedTask.id],
        queryFn: () => schedulerReadHistory(selectedTask.id, 10),
        enabled: isOpen,
        refetchInterval: 15_000,
    })

    const finishedRuns = useMemo(
        () => (historyQuery.data ?? []).filter((line) => line.event === 'finished'),
        [historyQuery.data]
    )

    // From the validation query, i.e. computed in Rust by the tick's own cron matcher — a JS
    // library here can (and did) predict fires real cron never performs (dom/dow star flag).
    // The `now` filter keeps the list fresh between refetches of the 30s-anchored query.
    const upcomingRuns = useMemo(
        () =>
            (cronValidation.data?.nextRuns ?? [])
                .map((run) => new Date(run))
                .filter((run) => run.getTime() > now),
        [cronValidation.data, now]
    )

    const hasChanges = useMemo(
        () =>
            name !== (selectedTask.name ?? '') ||
            cronExpression !== selectedTask.cron ||
            isEnabled !== selectedTask.isEnabled ||
            maxRunHoursNumber !== (selectedTask.maxRunHours ?? DEFAULT_MAX_RUN_HOURS),
        [name, cronExpression, isEnabled, maxRunHoursNumber, selectedTask]
    )

    const logQuery = useQuery({
        queryKey: ['scheduler', 'log', selectedTask.id],
        queryFn: () => schedulerReadLog(selectedTask.id),
        enabled: isOpen,
        refetchInterval: 5_000,
    })

    const saveMutation = useMutation({
        mutationFn: async () => {
            setSaveError(null)
            await schedulerUpdateTask(selectedTask.id, {
                name: name.trim(),
                cron: cronExpression,
                isEnabled,
                maxRunHours: maxRunHoursNumber,
            })
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['scheduler'] })
            onClose()
        },
        onError: (error) => {
            setSaveError(formatErrorMessage(error, 'Failed to save the schedule'))
        },
    })

    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={onClose}
            hideCloseButton={true}
        >
            <DrawerContent className={cn('bg-content1/80 backdrop-blur-md dark:bg-content1/90')}>
                {(close) => (
                    <>
                        <DrawerHeader className="px-0 pb-0">
                            <div className="flex flex-col w-full gap-2">
                                <div className="flex flex-row items-center w-full gap-4 pl-6 pr-4 pb-0.5">
                                    <p className="shrink-0">Edit Schedule</p>
                                    <Chip
                                        size="sm"
                                        variant="flat"
                                        color={
                                            selectedTask.operation === 'delete'
                                                ? 'danger'
                                                : selectedTask.operation === 'copy'
                                                  ? 'success'
                                                  : 'primary'
                                        }
                                    >
                                        {selectedTask.operation.toUpperCase()}
                                    </Chip>
                                </div>
                                <Divider />
                            </div>
                        </DrawerHeader>
                        <DrawerBody className="py-0">
                            <ScrollShadow size={30} visibility="top">
                                <div className="flex flex-col gap-6 pt-6 pb-10">
                                    {!!selectedTask.registrationError && (
                                        <Alert
                                            color="danger"
                                            variant="faded"
                                            title="Not registered with the scheduler"
                                        >
                                            <pre className="text-sm break-all whitespace-pre-wrap">
                                                {selectedTask.registrationError}
                                            </pre>
                                        </Alert>
                                    )}
                                    {!!saveError && (
                                        <Alert color="danger" variant="faded" title="Save failed">
                                            <pre className="text-sm break-all whitespace-pre-wrap">
                                                {saveError}
                                            </pre>
                                        </Alert>
                                    )}

                                    <div className="flex flex-col gap-6">
                                        <div className="flex flex-row justify-center w-full gap-8">
                                            <div className="flex flex-col items-end flex-1 gap-2">
                                                <h4 className="font-medium">Enabled</h4>
                                            </div>
                                            <div className="flex flex-col w-3/5 gap-3">
                                                <Switch
                                                    size="sm"
                                                    color="primary"
                                                    isSelected={isEnabled}
                                                    onValueChange={setIsEnabled}
                                                    aria-label="Enabled"
                                                    data-focus-visible="false"
                                                />
                                            </div>
                                        </div>

                                        <div className="flex flex-row justify-center w-full gap-8">
                                            <div className="flex flex-col items-end flex-1 gap-2">
                                                <h4 className="font-medium">Name</h4>
                                            </div>
                                            <div className="flex flex-col w-3/5 gap-3">
                                                <Input
                                                    aria-label="Schedule name"
                                                    placeholder="Untitled Schedule"
                                                    value={name}
                                                    onValueChange={setName}
                                                    autoCapitalize="off"
                                                    autoComplete="off"
                                                    autoCorrect="off"
                                                    spellCheck="false"
                                                    data-focus-visible="false"
                                                />
                                            </div>
                                        </div>

                                        <div className="flex flex-row justify-center w-full gap-8">
                                            <div className="flex flex-col items-end flex-1 gap-2">
                                                <h4 className="font-medium">Source</h4>
                                            </div>
                                            <div className="flex flex-col w-3/5 gap-3">
                                                <Tooltip
                                                    content={
                                                        <span className="font-mono break-all">
                                                            {source}
                                                        </span>
                                                    }
                                                    placement="top-start"
                                                    color="foreground"
                                                    className="max-w-md"
                                                >
                                                    <p className="font-mono text-sm break-all w-fit">
                                                        {buildReadablePath(source, 'long')}
                                                    </p>
                                                </Tooltip>
                                            </div>
                                        </div>

                                        {destination && (
                                            <div className="flex flex-row justify-center w-full gap-8">
                                                <div className="flex flex-col items-end flex-1 gap-2">
                                                    <h4 className="font-medium">Destination</h4>
                                                </div>
                                                <div className="flex flex-col w-3/5 gap-3">
                                                    <Tooltip
                                                        content={
                                                            <span className="font-mono break-all">
                                                                {destination}
                                                            </span>
                                                        }
                                                        placement="top-start"
                                                        color="foreground"
                                                        className="max-w-md"
                                                    >
                                                        <p className="font-mono text-sm break-all w-fit">
                                                            {buildReadablePath(destination, 'long')}
                                                        </p>
                                                    </Tooltip>
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex flex-row justify-center w-full gap-8">
                                            <div className="flex flex-col items-end flex-1 gap-2">
                                                <h4 className="font-medium">Max run time</h4>
                                            </div>
                                            <div className="flex flex-col w-3/5 gap-2">
                                                <Input
                                                    type="number"
                                                    aria-label="Max run time in hours"
                                                    endContent={
                                                        <span className="text-small text-default-400">
                                                            hours
                                                        </span>
                                                    }
                                                    min={1}
                                                    max={MAX_RUN_HOURS_LIMIT}
                                                    value={maxRunHours}
                                                    onValueChange={setMaxRunHours}
                                                    isInvalid={maxRunHoursInvalid}
                                                    errorMessage={`Enter a whole number of hours between 1 and ${MAX_RUN_HOURS_LIMIT}`}
                                                    className="max-w-36"
                                                    data-focus-visible="false"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <Divider />

                                    <div className="flex flex-col gap-3">
                                        <h3 className="text-lg font-medium">Schedule</h3>
                                        <CronEditor
                                            expression={cronExpression}
                                            onChange={(expr) =>
                                                setCronExpression(expr || '* * * * *')
                                            }
                                            error={cronError}
                                        />
                                    </div>

                                    <Divider />

                                    <div className="flex flex-col gap-3">
                                        <h3 className="text-lg font-medium">Upcoming Runs</h3>
                                        {upcomingRuns.length > 0 ? (
                                            <div className="flex flex-row justify-between">
                                                <div className="flex flex-col gap-2">
                                                    {upcomingRuns.slice(0, 5).map((run, index) => (
                                                        <UpcomingRunRow
                                                            key={run.toISOString()}
                                                            run={run}
                                                            index={index}
                                                        />
                                                    ))}
                                                </div>
                                                {upcomingRuns.length > 5 && (
                                                    <div className="flex flex-col gap-2">
                                                        {upcomingRuns
                                                            .slice(5, 10)
                                                            .map((run, index) => (
                                                                <UpcomingRunRow
                                                                    key={run.toISOString()}
                                                                    run={run}
                                                                    index={index + 5}
                                                                />
                                                            ))}
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <p className="text-sm text-foreground-500">
                                                No upcoming runs scheduled (invalid cron expression)
                                            </p>
                                        )}
                                    </div>

                                    <Divider />

                                    <div className="flex flex-col gap-3">
                                        <h3 className="text-lg font-medium">Run History</h3>
                                        {finishedRuns.length > 0 ? (
                                            <div className="flex flex-col gap-2">
                                                {finishedRuns.map((run) =>
                                                    run.event === 'finished' ? (
                                                        <div
                                                            key={run.runId}
                                                            className="flex items-center gap-3 text-sm rounded-small"
                                                        >
                                                            <Chip
                                                                size="sm"
                                                                variant="flat"
                                                                color={
                                                                    run.success
                                                                        ? 'success'
                                                                        : 'danger'
                                                                }
                                                            >
                                                                {run.success ? 'OK' : 'Failed'}
                                                            </Chip>
                                                            <span>
                                                                {formatDistance(
                                                                    new Date(run.ts),
                                                                    new Date(now),
                                                                    { addSuffix: true }
                                                                )}
                                                            </span>
                                                            <span className="text-foreground-500">
                                                                {Math.round(run.durationMs / 1000)}s
                                                            </span>
                                                            {!!run.error && (
                                                                <span className="text-danger-500 line-clamp-1">
                                                                    {run.error}
                                                                </span>
                                                            )}
                                                        </div>
                                                    ) : null
                                                )}
                                            </div>
                                        ) : (
                                            <p className="text-sm text-foreground-500">
                                                This task hasn't run yet.
                                            </p>
                                        )}
                                    </div>

                                    <Divider />

                                    <div className="flex flex-col gap-3">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-lg font-medium">Log</h3>
                                            <Button
                                                size="sm"
                                                variant="flat"
                                                onPress={() => {
                                                    onClose()
                                                    navigate(`/transfers?task=${selectedTask.id}`)
                                                }}
                                                data-focus-visible="false"
                                            >
                                                See the runs in Transfers
                                            </Button>
                                        </div>
                                        <p className="text-tiny text-default-400">
                                            What the scheduler did, run by run. What a run moved is
                                            its transfer's, on the Transfers page.
                                            {logQuery.data?.truncated &&
                                                ' Showing the last 64 KB — older lines are on disk.'}
                                        </p>
                                        <pre className="p-3 overflow-auto font-mono whitespace-pre-wrap rounded-medium bg-content2 text-tiny max-h-64">
                                            {logQuery.data?.content || 'No runs yet.'}
                                        </pre>
                                    </div>
                                </div>
                            </ScrollShadow>
                        </DrawerBody>
                        <DrawerFooter>
                            <Button
                                color="danger"
                                variant="light"
                                onPress={() => close()}
                                data-focus-visible="false"
                            >
                                CANCEL
                            </Button>
                            <Button
                                color="primary"
                                isDisabled={!hasChanges || !!cronError || maxRunHoursInvalid}
                                isLoading={saveMutation.isPending}
                                onPress={() => saveMutation.mutate()}
                                data-focus-visible="false"
                            >
                                SAVE CHANGES
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}

function UpcomingRunRow({ run, index }: { run: Date; index: number }) {
    return (
        <div className="flex items-center gap-3 text-sm">
            <Chip size="sm" variant="flat" color="default">
                {index + 1}
            </Chip>
            <span>{format(run, 'EEEE, MMMM d, yyyy')}</span>
            <span className="text-foreground-500">at</span>
            <span className="font-mono">{format(run, 'HH:mm')}</span>
        </div>
    )
}
