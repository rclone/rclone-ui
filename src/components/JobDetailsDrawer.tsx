import {
    Alert,
    Button,
    Chip,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerHeader,
    Progress,
    Spinner,
    Tooltip,
    cn,
} from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { message } from '@tauri-apps/plugin-dialog'
import { platform } from '@tauri-apps/plugin-os'
import { ExternalLinkIcon, RefreshCwIcon, SearchCheckIcon, SquareIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatBytes } from '../../lib/format'
import { useIsPreview } from '../../lib/preview'
import { notify } from '../../lib/notifications'
import { startBatch } from '../../lib/rclone/api'
import rclone from '../../lib/rclone/client'
import { useStore } from '../../store/memory'
import type { JobItem } from '../../types/jobs'

export default function JobDetailsDrawer({
    isOpen,
    onClose,
    selectedJob,
    onSelectJob,
}: {
    isOpen: boolean
    onClose: () => void
    selectedJob: JobItem
    onSelectJob?: (job: JobItem) => void
}) {
    const queryClient = useQueryClient()
    const isPreview = useIsPreview()
    const [retryStatus, setRetryStatus] = useState<
        Map<string, { status: 'pending' | 'started' | 'error'; jobId?: number; error?: string }>
    >(new Map())

    const jobStatusQuery = useQuery({
        queryKey: ['jobs', 'status', selectedJob.id],
        queryFn: async () =>
            rclone('/job/status', {
                params: {
                    query: {
                        jobid: selectedJob.id,
                    },
                },
            }),
        enabled: !!selectedJob.id,
        refetchInterval: 1000,
    })

    const mainError = useMemo(() => jobStatusQuery.data?.error || null, [jobStatusQuery.data])

    const otherErrors = useMemo(
        () =>
            !!jobStatusQuery.data?.output &&
            typeof jobStatusQuery.data?.output === 'object' &&
            'results' in jobStatusQuery.data.output &&
            Array.isArray(jobStatusQuery.data.output.results)
                ? (jobStatusQuery.data.output.results
                      .map((item: any) => {
                          if (!item.error) return null
                          return { error: item.error, input: item.input }
                      })
                      .filter(Boolean) as { error: string; input: object }[])
                : [],
        [jobStatusQuery.data]
    )

    const transferredQuery = useQuery({
        queryKey: ['jobs', 'transferring', selectedJob.id],
        queryFn: async () =>
            rclone('/core/transferred', {
                params: {
                    query: {
                        group: `job/${selectedJob.id}`,
                    },
                },
            }),
        enabled: !!selectedJob.id,
        refetchInterval: 1000,
    })

    const jobGroupStatsQuery = useQuery({
        queryKey: ['jobs', 'group', 'stats', selectedJob.id],
        queryFn: async () =>
            rclone('/core/stats', {
                params: {
                    query: {
                        group: `job/${selectedJob.id}`,
                    },
                },
            }),
        enabled: !!selectedJob.id,
        refetchInterval: 1000,
    })

    const stopJobMutation = useMutation({
        mutationFn: async (jobId: number) => {
            // Un-watch before stopping: a stopped job finishes with an error, which would
            // otherwise surface as a bogus "Transfer failed" webhook notification.
            useStore.setState((state) => {
                const watchedJobs = { ...state.watchedJobs }
                delete watchedJobs[jobId]
                return { watchedJobs }
            })
            await rclone('/job/stopgroup', {
                params: {
                    query: {
                        group: `job/${jobId}`,
                    },
                },
            })
        },
        onSuccess: async () => {
            queryClient.refetchQueries({ queryKey: ['transfers', 'list', 'all'] })
            await notify({
                title: 'Job stopped',
                body: 'It will still appear as active, with declining transfer speeds, until rclone cleans it up',
            })
        },
        onError: async (error) => {
            console.error('Failed to stop job:', error)
            await message(error instanceof Error ? error.message : 'Unknown error occurred', {
                title: 'Could not stop job',
                kind: 'error',
            })
        },
    })

    const retryMutation = useMutation({
        mutationFn: async ({
            key,
            input,
        }: { key: string; input: { _path: string } & Record<string, any> }) => {
            setRetryStatus((prev) => new Map(prev).set(key, { status: 'pending' }))
            const jobId = await startBatch([input], undefined, {
                configParam: typeof input._config === 'string' ? input._config : undefined,
            })
            return { key, jobId }
        },
        onSuccess: ({ key, jobId }) => {
            setRetryStatus((prev) => new Map(prev).set(key, { status: 'started', jobId }))
            queryClient.refetchQueries({ queryKey: ['transfers', 'list', 'all'] })
        },
        onError: (error, { key }) => {
            console.error('Failed to retry transfer:', error)
            setRetryStatus((prev) =>
                new Map(prev).set(key, {
                    status: 'error',
                    error: error instanceof Error ? error.message : 'Unknown error',
                })
            )
        },
    })

    const transferred = useMemo(
        () => transferredQuery.data?.transferred || [],
        [transferredQuery.data]
    )
    const transferring = useMemo(
        () => jobGroupStatsQuery.data?.transferring || [],
        [jobGroupStatsQuery.data]
    )
    const checking = useMemo(
        () => jobGroupStatsQuery.data?.checking || [],
        [jobGroupStatsQuery.data]
    )

    const errorInputMap = useMemo(() => {
        const map = new Map<string, { _path: string } & Record<string, any>>()
        for (const err of otherErrors) {
            const input = err.input as { srcRemote?: string; _path: string } & Record<string, any>
            if (input?.srcRemote) {
                map.set(input.srcRemote, input)
            }
        }
        return map
    }, [otherErrors])

    return (
        <Drawer isOpen={isOpen} placement="bottom" size="2xl" onClose={onClose}>
            <DrawerContent
                className={cn(
                    'bg-content1/80 backdrop-blur-md dark:bg-content1/90',
                    platform() === 'macos' ? 'pt-6' : undefined
                )}
            >
                <DrawerHeader className="flex flex-row items-center gap-2">
                    Job Details #{selectedJob.id}{' '}
                    {selectedJob.type === 'inactive' ? (
                        <Chip color="primary" size="sm">
                            FINISHED
                        </Chip>
                    ) : (
                        <Tooltip content="Stop job" placement="right" color="foreground">
                            <Button
                                isIconOnly={true}
                                color="danger"
                                size="sm"
                                variant="light"
                                onPress={() => {
                                    stopJobMutation.mutate(selectedJob.id)
                                }}
                            >
                                <SquareIcon fill="currentColor" className="w-5 rounded-small" />
                            </Button>
                        </Tooltip>
                    )}
                </DrawerHeader>
                <DrawerBody className="pb-10">
                    {mainError || otherErrors.length > 0 ? (
                        <Alert color="danger" variant="faded" hideIcon={true}>
                            {mainError}
                            {otherErrors.length > 0 ? (
                                <pre className="break-all whitespace-pre-wrap">
                                    {JSON.stringify(otherErrors, null, 2)}
                                </pre>
                            ) : null}
                        </Alert>
                    ) : null}

                    {selectedJob.isDryRun && (
                        <Alert color="warning" variant="faded">
                            This is a dry-run operation. No files were actually transferred.
                        </Alert>
                    )}

                    {checking.length > 0 ? (
                        <div className="flex flex-col gap-2 pb-4">
                            <div className="flex flex-row items-center justify-between gap-2">
                                <h3 className="flex flex-row items-center gap-2 text-lg font-medium">
                                    <SearchCheckIcon className="w-5 h-5 text-warning" />
                                    Checking
                                </h3>
                                {jobGroupStatsQuery.isLoading ? (
                                    <Spinner />
                                ) : (
                                    <Chip size="sm" color="warning" variant="flat">
                                        {checking.length} item{checking.length === 1 ? '' : 's'}
                                    </Chip>
                                )}
                            </div>
                            <p className="text-sm text-default-500">
                                Files are being verified before transfer. This can take a while for
                                large directories.
                            </p>
                            {checking.map((item, itemIndex) => {
                                const size = item.size ? formatBytes(item.size) : 'Unknown size'
                                return (
                                    <div
                                        key={item.name || itemIndex}
                                        className="flex flex-row items-center justify-between gap-2 pb-2 border-b border-divider"
                                    >
                                        <p className="flex-1 line-clamp-1 min-w-80">{item.name}</p>
                                        <p className="text-sm tabular-nums text-default-500">
                                            {size}
                                        </p>
                                    </div>
                                )
                            })}
                        </div>
                    ) : null}

                    <div className="flex flex-col gap-2">
                        <div className="flex flex-row items-center justify-between gap-2">
                            <h3 className="text-lg font-medium">Transferring</h3>
                            {jobGroupStatsQuery.isLoading ? (
                                <Spinner />
                            ) : (
                                `${transferring.length} items`
                            )}
                        </div>

                        {!jobGroupStatsQuery.isLoading && transferring.length === 0 ? (
                            <p>No items transferring</p>
                        ) : null}

                        {transferring.map((item, itemIndex) => {
                            // biome-ignore lint/style/useExplicitLengthCheck: <not relevant>
                            const size = item.size ? formatBytes(item.size) : '0 B'
                            const bytes = item.bytes ? formatBytes(item.bytes) : '0 B'
                            const speed = item.speed ? formatBytes(item.speed) : '0 B/s'
                            return (
                                <div
                                    key={item.name || itemIndex}
                                    className="flex flex-row items-center justify-between gap-5 pb-2 border-b border-divider"
                                >
                                    <p className="flex-1 line-clamp-1 min-w-80">{item.name}</p>
                                    <p className="w-24 tabular-nums shrink-0 whitespace-nowrap">
                                        {speed}/s
                                    </p>
                                    <Tooltip
                                        content={`Transferred ${bytes} of ${size}`}
                                        color="foreground"
                                        placement="bottom"
                                        size="lg"
                                    >
                                        <Progress
                                            value={item.percentage}
                                            disableAnimation={isPreview}
                                            classNames={{
                                                base: 'overflow-hidden rounded-full max-w-lg',
                                            }}
                                        />
                                    </Tooltip>
                                </div>
                            )
                        })}
                    </div>

                    <div className="flex flex-col gap-8 pt-6 ">
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-row items-center justify-between gap-2 pb-2">
                                <h3 className="text-lg font-medium">Transferred</h3>
                                {transferredQuery.isLoading ? (
                                    <Spinner />
                                ) : (
                                    `${transferred.length} items`
                                )}
                            </div>

                            {!transferredQuery.isLoading && transferred.length === 0 ? (
                                <p>No items transferred</p>
                            ) : null}

                            {transferred.map((item, itemIndex) => {
                                const itemKey = item.name || `item-${itemIndex}`
                                const itemRetryStatus = retryStatus.get(itemKey)
                                const inputForRetry = item.name
                                    ? errorInputMap.get(item.name)
                                    : undefined
                                const canRetry =
                                    item.error && inputForRetry && !itemRetryStatus?.status

                                return (
                                    <div
                                        key={itemKey}
                                        className="flex flex-row items-center justify-between gap-2 pb-2 border-b border-divider"
                                    >
                                        <p className="flex-1 line-clamp-1">{item.name}</p>

                                        {itemRetryStatus?.status === 'pending' && (
                                            <div className="flex items-center gap-2 text-default-500">
                                                <Spinner size="sm" />
                                                <span className="text-sm">Retrying...</span>
                                            </div>
                                        )}

                                        {itemRetryStatus?.status === 'started' &&
                                            itemRetryStatus.jobId && (
                                                <div className="flex items-center gap-2">
                                                    <Chip size="sm" color="success" variant="flat">
                                                        Job #{itemRetryStatus.jobId}
                                                    </Chip>
                                                    {onSelectJob && (
                                                        <Tooltip
                                                            content="View new job"
                                                            color="foreground"
                                                        >
                                                            <Button
                                                                isIconOnly={true}
                                                                size="sm"
                                                                variant="light"
                                                                onPress={() => {
                                                                    onClose()
                                                                    setTimeout(() => {
                                                                        onSelectJob({
                                                                            id: itemRetryStatus.jobId!,
                                                                            type: 'active',
                                                                            bytes: 0,
                                                                            totalBytes: 0,
                                                                            speed: 0,
                                                                            done: false,
                                                                            progress: 0,
                                                                            hasError: false,
                                                                            sources: [],
                                                                            isChecking: false,
                                                                            checkingCount: 0,
                                                                        })
                                                                    }, 300)
                                                                }}
                                                            >
                                                                <ExternalLinkIcon className="w-4 h-4" />
                                                            </Button>
                                                        </Tooltip>
                                                    )}
                                                </div>
                                            )}

                                        {itemRetryStatus?.status === 'error' && (
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm text-danger">
                                                    {itemRetryStatus.error || 'Retry failed'}
                                                </span>
                                                {inputForRetry && (
                                                    <Tooltip
                                                        content="Retry again"
                                                        color="foreground"
                                                    >
                                                        <Button
                                                            isIconOnly={true}
                                                            size="sm"
                                                            color="warning"
                                                            variant="flat"
                                                            onPress={() => {
                                                                setRetryStatus((prev) => {
                                                                    const newMap = new Map(prev)
                                                                    newMap.delete(itemKey)
                                                                    return newMap
                                                                })
                                                                retryMutation.mutate({
                                                                    key: itemKey,
                                                                    input: inputForRetry,
                                                                })
                                                            }}
                                                        >
                                                            <RefreshCwIcon className="w-4 h-4" />
                                                        </Button>
                                                    </Tooltip>
                                                )}
                                            </div>
                                        )}

                                        {!itemRetryStatus && item.error && (
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm text-danger line-clamp-1 max-w-64">
                                                    {item.error}
                                                </span>
                                                {canRetry && inputForRetry && (
                                                    <Tooltip
                                                        content="Retry this file"
                                                        color="foreground"
                                                    >
                                                        <Button
                                                            isIconOnly={true}
                                                            size="sm"
                                                            color="danger"
                                                            variant="flat"
                                                            onPress={() =>
                                                                retryMutation.mutate({
                                                                    key: itemKey,
                                                                    input: inputForRetry,
                                                                })
                                                            }
                                                        >
                                                            <RefreshCwIcon className="w-4 h-4" />
                                                        </Button>
                                                    </Tooltip>
                                                )}
                                            </div>
                                        )}

                                        {!itemRetryStatus && !item.error && item.completed_at && (
                                            <p className="text-sm text-default-500">
                                                {new Date(item.completed_at).toLocaleString()}
                                            </p>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </DrawerBody>
            </DrawerContent>
        </Drawer>
    )
}
