import * as Sentry from '@sentry/browser'
import { message } from '@tauri-apps/plugin-dialog'
import { platform } from '@tauri-apps/plugin-os'
import pRetry from 'p-retry'
import { selectActiveConfigFile, useHostStore } from '../../store/host'
import { type WatchedJob, useStore } from '../../store/memory'
import { selectCurrentHost, usePersistedStore } from '../../store/persisted'
import type { JobItem } from '../../types/jobs'
import type { FlagValue } from '../../types/rclone'
import { UserCancelledError, formatErrorMessage } from '../errors'
import { getFsInfo } from '../format'
import { dispatchNotification } from '../notifications'
import { restartActiveRclone, runRcloneCli } from './cli'
import rclone, { rcloneAsync } from './client'
import {
    type BisyncArgs,
    type CopyArgs,
    type DeleteArgs,
    type MoveArgs,
    type PurgeArgs,
    type SyncArgs,
    buildBisyncRequests,
    buildCopyRequests,
    buildDeleteRequests,
    buildMoveRequests,
    buildPurgeRequests,
    buildSyncRequests,
    serializeOptions,
    toConfigParam,
    toFilterParam,
} from './requests'
import { getAuthHeader, rcFetch } from './session'

const RE_BACKSLASH = /\\/g
const RE_DASH = /-/g
const RE_PATH_SEPARATOR = /[/\\]/
const RE_WINDOWS_EXTENDED_PATH = /(\/\/\?\/|\\\\\?\\)/
const RE_WINDOWS_DRIVE_LETTER = /^[a-zA-Z]:$/

const RETRY_OPTIONS = {
    retries: 3,
    shouldRetry: ({ error }: { error: unknown }) => !(error instanceof UserCancelledError),
}

// Dry-run state travels with each submission so a preview never changes daemon-global options or
// suppresses a real job that overlaps it.
export function startDryRun<T>(operation: (isDryRun: true) => Promise<T>): Promise<T> {
    return operation(true)
}

// Makes a freshly submitted job visible to the main window's job watcher (via the shared
// broadcast store), which emits the job started/completed/failed notifications.
// Called BEFORE the launch verification so jobs that fail within the first second still get
// a failure notification from the watcher.
function registerWatchedJob(
    jobid: number,
    job: Pick<WatchedJob, 'operation' | 'sources' | 'destination'>
) {
    useStore.setState((state) => ({
        watchedJobs: {
            ...state.watchedJobs,
            [jobid]: {
                ...job,
                jobid,
                startedAt: Date.now(),
            },
        },
    }))
}

function registerSubmittedJob(
    jobid: number,
    job: Pick<WatchedJob, 'operation' | 'sources' | 'destination'>,
    isDryRun: boolean
) {
    if (isDryRun) {
        useStore.setState((state) => ({
            dryRunJobIds: state.dryRunJobIds.includes(jobid)
                ? state.dryRunJobIds
                : [...state.dryRunJobIds, jobid],
        }))
        return
    }
    registerWatchedJob(jobid, job)
}

async function hasStat(
    path: string,
    options?: {
        configParam?: string
        remotes?: Record<string, Record<string, FlagValue>>
    }
) {
    // No try/catch: a transport failure must propagate as the real error instead of being
    // masked as "Source does not exist". A genuinely missing path returns a response with no
    // item, which still yields false.
    const { root, filePath, remoteName } = getFsInfo(path)
    const remoteOptions = options?.remotes?.[remoteName]
    let fs = root === ':local:' ? ':local:/' : root
    if (remoteOptions && Object.keys(remoteOptions).length > 0) {
        fs = serializeOptions(root.endsWith('/') ? root.slice(0, -1) : root, {
            remote: remoteOptions,
        })
    }
    const r = await rclone('/operations/stat', {
        params: {
            query: {
                fs,
                remote: filePath,
                ...(options?.configParam ? { _config: options.configParam } : {}),
            },
        },
    })
    return !!r?.item
}

export async function startCopy(args: CopyArgs, isDryRun = false) {
    console.log('[startCopy] starting', {
        sources: args.sources,
        destination: args.destination,
        optionKeys: Object.keys(args.options),
    })

    const [request] = buildCopyRequests(args)

    for (const source of args.sources) {
        const sourceExists = await hasStat(source, {
            configParam: request.body._config,
            remotes: args.options.remotes,
        })
        if (!sourceExists) {
            throw new Error(`Source does not exist, ${source} is missing`)
        }
    }

    console.log('[startCopy] submitting batch', { jobCount: request.body.inputs.length })
    return startBatch(
        request.body.inputs,
        {
            operation: 'copy',
            sources: args.sources,
            destination: args.destination,
        },
        { isDryRun, configParam: request.body._config }
    )
}

export async function startMove(args: MoveArgs, isDryRun = false) {
    console.log('[startMove] starting', {
        sources: args.sources,
        destination: args.destination,
        optionKeys: Object.keys(args.options),
    })

    const [request] = buildMoveRequests(args)

    for (const source of args.sources) {
        const sourceExists = await hasStat(source, {
            configParam: request.body._config,
            remotes: args.options.remotes,
        })
        if (!sourceExists) {
            throw new Error(`Source does not exist, ${source} is missing`)
        }
    }

    console.log('[startMove] submitting batch', { jobCount: request.body.inputs.length })
    return startBatch(
        request.body.inputs,
        {
            operation: 'move',
            sources: args.sources,
            destination: args.destination,
        },
        { isDryRun, configParam: request.body._config }
    )
}

/* JOBS */
async function fetchTransferred() {
    const transferredStats = await rclone('/core/transferred')

    const transferred = transferredStats?.transferred

    return transferred
}

async function fetchJob(
    jobId: number,
    transferred: Awaited<ReturnType<typeof fetchTransferred>>,
    checkingItems: { group?: string; name?: string; size?: number }[]
) {
    console.log('[fetchJob] fetching job', jobId)

    const job = await rclone('/core/stats', {
        params: {
            query: {
                group: `job/${jobId}`,
            },
        },
    })
    console.log('[fetchJob] job stats', jobId, JSON.stringify(job, null, 2))

    const jobStatus = await rclone('/job/status', {
        params: {
            query: {
                jobid: jobId,
            },
        },
    })
    console.log('[fetchJob] job status', jobId, JSON.stringify(jobStatus, null, 2))

    let hasError = !!jobStatus?.error
    const isDryRun = useStore.getState().dryRunJobIds.includes(jobId)

    if (
        jobStatus.output &&
        typeof jobStatus.output === 'object' &&
        'results' in jobStatus.output &&
        Array.isArray(jobStatus.output.results)
    ) {
        if (!hasError) {
            hasError = jobStatus.output.results.some((result: any) => !!result?.error)
        }
    }

    const jobCheckingItems = checkingItems.filter((c) => c.group === `job/${jobId}`)
    const isChecking = jobCheckingItems.length > 0
    const checkingCount = jobCheckingItems.length

    console.log('[fetchJob] checking state', jobId, { isChecking, checkingCount })

    const relatedItems = transferred.filter((t) => t.group === `job/${jobId}`)

    if (relatedItems.length === 0 && !isChecking) {
        console.log('[fetchJob] no relatedItems and not checking', jobId)
        return null
    }

    console.log('[fetchJob] relatedItems', JSON.stringify(relatedItems, null, 2))

    const sources = new Set<string>()

    if (relatedItems.length === 1) {
        if (relatedItems[0].srcFs) {
            const combinedSource = `${relatedItems[0].srcFs}${relatedItems[0].name}`

            sources.add(
                platform() === 'windows'
                    ? combinedSource.replace(RE_WINDOWS_EXTENDED_PATH, '')
                    : combinedSource
            )
        }
    } else {
        for (const item of relatedItems) {
            if (item.srcFs) {
                sources.add(
                    platform() === 'windows'
                        ? item.srcFs.replace(RE_WINDOWS_EXTENDED_PATH, '')
                        : item.srcFs
                )
            }
        }
    }

    if (isChecking && sources.size === 0) {
        for (const checkItem of jobCheckingItems) {
            if (checkItem.name) {
                sources.add(checkItem.name)
            }
        }
    }

    if (sources.size === 0 && !hasError) {
        console.log('[fetchJob] source or hasError not found', jobId)
        return null
    }

    return {
        id: jobId,
        bytes: job.bytes,
        totalBytes: job.totalBytes,
        speed: job.speed,

        done: job.bytes === job.totalBytes,
        progress: job.totalBytes > 0 ? Math.round((job.bytes / job.totalBytes) * 100) : 0,
        hasError: hasError,

        sources: Array.from(sources),
        isChecking,
        checkingCount,
        isDryRun,
    }
}

export async function listTransfers() {
    console.log('[listTransfers] starting')

    const allStats = await rclone('/core/stats')
    console.log('[listTransfers] allStats', JSON.stringify(allStats, null, 2))

    const transferring = allStats?.transferring || []
    const checking = allStats?.checking || []

    console.log('[listTransfers] transferring count:', transferring.length)
    console.log('[listTransfers] checking count:', checking.length)

    const transferred = await fetchTransferred()
    console.log('[listTransfers] transferred count:', transferred?.length || 0)

    const jobs = {
        active: [] as JobItem[],
        inactive: [] as JobItem[],
    }

    const transferringJobIds = new Set(
        transferring
            .filter((t) => t.group?.startsWith('job/'))
            .map((t) => Number(t.group!.split('/')[1]))
    )

    const checkingJobIds = new Set(
        checking
            .filter((c) => c.group?.startsWith('job/'))
            .map((c) => Number(c.group!.split('/')[1]))
    )

    const activeJobIds = new Set([...transferringJobIds, ...checkingJobIds])
    const sortedActiveJobIds = Array.from(activeJobIds).sort((a, b) => a - b)

    console.log('[listTransfers] transferring job IDs:', Array.from(transferringJobIds))
    console.log('[listTransfers] checking job IDs:', Array.from(checkingJobIds))
    console.log('[listTransfers] combined active job IDs:', sortedActiveJobIds)

    const isWindows = platform() === 'windows'
    console.log('[listTransfers] isWindows', isWindows)

    for (const jobId of sortedActiveJobIds) {
        const job = await fetchJob(jobId, transferred, checking)
        if (job) {
            jobs.active.push({
                ...job,
                type: 'active',
            })
        }
    }

    const inactiveJobIds = new Set(
        transferred
            ?.filter((t) => t.group?.startsWith('job/'))
            .map((t) => Number(t.group!.split('/')[1]))
            .filter((id) => !activeJobIds.has(id))
            .sort((a, b) => a - b)
    )
    console.log('[listTransfers] inactive job IDs:', Array.from(inactiveJobIds))

    for (const jobId of inactiveJobIds) {
        const job = await fetchJob(jobId, transferred, checking)
        if (job) {
            jobs.inactive.push({
                ...job,
                speed: 0,
                type: 'inactive',
                isChecking: false,
                checkingCount: 0,
            })
        }
    }

    console.log(
        '[listTransfers] final result - active:',
        jobs.active.length,
        'inactive:',
        jobs.inactive.length
    )

    return jobs
}

/* OPERATIONS */
// Wraps the mount flow so every caller (Mount page, tray, startup automounts) emits the
// mount.failed webhook event without per-site wiring. Rethrows for the caller's own handling.
export async function startMount(params: Parameters<typeof startMountInner>[0]) {
    try {
        return await startMountInner(params)
    } catch (error) {
        dispatchNotification('mount.failed', {
            title: 'Mount failed',
            body: `Failed to mount ${params.source}: ${formatErrorMessage(error, 'Unknown error')}`,
            data: {
                source: params.source,
                destination: params.destination,
                error: formatErrorMessage(error, String(error)),
            },
        })
        throw error
    }
}

async function startMountInner({
    source,
    destination,
    options,
}: {
    source: string
    destination: string
    options: {
        mount?: Record<string, FlagValue>
        vfs?: Record<string, FlagValue>
        filter?: Record<string, FlagValue>
        config?: Record<string, FlagValue>
        remotes?: Record<string, Record<string, FlagValue>>
    }
}) {
    const currentPlatform = platform()
    let needsVolumeName = currentPlatform === 'macos'

    if (
        currentPlatform === 'windows' &&
        destination !== '*' &&
        !RE_WINDOWS_DRIVE_LETTER.test(destination)
    ) {
        needsVolumeName = true
    }

    const mountOptions = { ...(options.mount || {}) }

    const hasVolumeName = 'volname' in mountOptions && mountOptions.volname
    if (!hasVolumeName && needsVolumeName) {
        const segments = source.split(RE_PATH_SEPARATOR).filter(Boolean)
        console.log('[Mount] segments', segments)

        const sourcePath = segments.length === 1 ? segments[0].replace(/:/g, '') : segments.pop()
        console.log('[Mount] sourcePath', sourcePath)

        mountOptions.volname = `${sourcePath}-${Math.random().toString(36).substring(2, 3).toUpperCase()}`
    }

    // `_filter` is the correct RC channel for mount filters (rclone's own RC docs say so), so we
    // send it as a proper param rather than smuggling it into the fs string. Note: current rclone
    // ignores it for mounts — mountRc has the filter on its ctx, but Mount() builds the VFS with
    // context.Background() and discards it (only the *global* filter, set via CLI --exclude, reaches
    // a mount). Rclone still parses this value, but it only affects the mount if upstream threads
    // that request context into the VFS.
    const configParam = toConfigParam(options.config)
    const filterParam = toFilterParam(options.filter)

    const vfsOptions = { ...(options.vfs || {}) }

    // mountOpt/vfsOpt take JSON keyed by Go field names, so rekey the flag-name groups
    // ("vfs_cache_mode" → "CacheMode") via the options/info registry before sending. Unknown
    // keys pass through untouched — rclone ignores unrecognized fields.
    const toStructOptions = (
        flags: Record<string, FlagValue>,
        infos: { Name: string; FieldName: string; Type: string }[] | undefined
    ) => {
        const optionsByName = new Map((infos || []).map((info) => [info.Name, info]))
        return JSON.stringify(
            Object.fromEntries(
                Object.entries(flags).map(([key, value]) => {
                    const normalized = (key.startsWith('--') ? key.slice(2) : key).replace(
                        RE_DASH,
                        '_'
                    )
                    const option = optionsByName.get(normalized)
                    return [
                        option?.FieldName || key,
                        option?.Type === 'stringArray' && !Array.isArray(value) && value !== null
                            ? [String(value)]
                            : value,
                    ]
                })
            )
        )
    }

    let structOptions: { mountOpt?: string; vfsOpt?: string } = {}
    if (Object.keys(mountOptions).length > 0 || Object.keys(vfsOptions).length > 0) {
        const optionsInfo = await pRetry(
            async () =>
                await rclone('/options/info', { params: { query: { blocks: 'mount,vfs' } } }),
            RETRY_OPTIONS
        )
        structOptions = {
            ...(Object.keys(mountOptions).length > 0
                ? { mountOpt: toStructOptions(mountOptions, optionsInfo?.mount) }
                : {}),
            ...(Object.keys(vfsOptions).length > 0
                ? { vfsOpt: toStructOptions(vfsOptions, optionsInfo?.vfs) }
                : {}),
        }
    }

    const { fullDirPath: srcFullDirPath, remoteName: srcRemoteName } = getFsInfo(source)

    const srcOptions =
        options.remotes && srcRemoteName && srcRemoteName in options.remotes
            ? options.remotes[srcRemoteName]
            : undefined

    if (destination === '*' && currentPlatform === 'windows') {
        const response = await pRetry(
            async () =>
                await rclone('/mount/mount', {
                    params: {
                        query: {
                            fs: serializeOptions(srcFullDirPath, {
                                remote: srcOptions,
                            }),
                            mountPoint: '*',
                            // No mountType — Windows uses rclone's default resolution (cmount/WinFsp)
                            ...structOptions,
                            ...(configParam ? { _config: configParam } : {}),
                            ...(filterParam ? { _filter: filterParam } : {}),
                        },
                    },
                }),
            RETRY_OPTIONS
        )
        return response?.mountPoint
    }

    const {
        root: dstRoot,
        filePath: dstFilePath,
        fullDirPath: dstFullDirPath,
    } = getFsInfo(destination)

    const dstFs = dstRoot === ':local:' ? ':local:/' : dstRoot
    const dstFilePathNormalized = dstFilePath.replace(RE_BACKSLASH, '/')

    let directoryExists: boolean | undefined

    try {
        const r = await pRetry(
            async () =>
                await rclone('/operations/stat', {
                    params: {
                        query: {
                            fs: dstFs,
                            remote: dstFilePathNormalized,
                        },
                    },
                }),
            RETRY_OPTIONS
        )
        if (!r || !r.item) {
            directoryExists = false
        } else {
            if (!r.item.IsDir) {
                throw new Error('The selected directory is not a directory')
            }
            directoryExists = true
        }
    } catch (err) {
        console.error('[Mount] Error checking if directory exists:', err)
    }
    console.log('[Mount] directoryExists', directoryExists)

    const isPlatformWindows = platform() === 'windows'

    if (directoryExists) {
        let isEmpty = false
        try {
            const { list } = await pRetry(
                async () =>
                    await rclone('/operations/list', {
                        params: {
                            query: {
                                fs: dstRoot === ':local:' ? ':local:/' : dstRoot,
                                remote: dstFilePath,
                            },
                        },
                    }),
                RETRY_OPTIONS
            )
            isEmpty = !list || list.length === 0
        } catch (err) {
            console.error('[Mount] Error checking if directory is empty:', err)
        }

        if (!isEmpty) {
            throw new Error('The selected directory must be empty to mount a remote.')
        }

        if (isPlatformWindows) {
            try {
                await pRetry(
                    async () =>
                        await rclone('/operations/rmdir', {
                            params: {
                                query: {
                                    fs: dstRoot === ':local:' ? ':local:/' : dstRoot,
                                    remote: dstFilePath,
                                },
                            },
                        }),
                    RETRY_OPTIONS
                )
            } catch (err) {
                console.error('[Mount] Error removing directory:', err)
            }
        }
    } else if (!isPlatformWindows) {
        try {
            await pRetry(
                async () =>
                    await rclone('/operations/mkdir', {
                        params: {
                            query: {
                                fs: dstRoot === ':local:' ? ':local:/' : dstRoot,
                                remote: dstFilePath,
                            },
                        },
                    }),
                RETRY_OPTIONS
            )
        } catch (error) {
            console.error('[Mount] Error creating directory:', error)
            throw new Error('Failed to create mount directory. Try creating it manually first.')
        }
    }

    await pRetry(
        async () =>
            await rclone('/mount/mount', {
                params: {
                    query: {
                        fs: serializeOptions(srcFullDirPath, {
                            remote: srcOptions,
                        }),
                        mountPoint: (() => {
                            if (platform() !== 'windows') {
                                return dstFullDirPath.replace(':local:', '/')
                            }
                            const mp = dstFullDirPath
                                .replace(':local:', '')
                                .replace(RE_BACKSLASH, '/')
                                .replace(/\/+/g, '/')
                            if (/^[a-zA-Z]:\/$/.test(mp)) {
                                return mp.slice(0, -1)
                            }
                            return mp
                        })(),
                        ...(currentPlatform === 'macos' ? { mountType: 'nfsmount' } : {}),
                        ...structOptions,
                        ...(configParam ? { _config: configParam } : {}),
                        ...(filterParam ? { _filter: filterParam } : {}),
                    },
                },
            }),
        RETRY_OPTIONS
    )
}

// Shared submission path for the async query endpoints (/sync/sync, /sync/bisync): submit,
// register with the watcher, verify the launch didn't fail within the first second.
async function submitAsyncQuery(
    endpoint: '/sync/sync' | '/sync/bisync',
    body: Record<string, any>,
    watch: Pick<WatchedJob, 'operation' | 'sources' | 'destination'>,
    isDryRun = false
) {
    // The builders emit body-form requests for the headless runner; the live client submits the
    // same parameters as a query (rclone's RC treats them identically).
    const { _async, ...query } = body

    const r = await pRetry(
        async () =>
            await rcloneAsync(endpoint, {
                params: {
                    query: query as any,
                },
            }),
        RETRY_OPTIONS
    )

    if (!r?.jobid) {
        console.error('Failed to start job: missing jobid', r)
        throw new Error('Failed to start operation')
    }

    registerSubmittedJob(r.jobid, watch, isDryRun)

    await new Promise((resolve) => setTimeout(resolve, 1000))

    const jobStatus = await pRetry(
        async () =>
            await rclone('/job/status', {
                params: {
                    query: {
                        jobid: r.jobid,
                    },
                },
            }),
        RETRY_OPTIONS
    ).catch(() => null)

    console.log('jobStatus', JSON.stringify(jobStatus, null, 2))

    if (!jobStatus) {
        console.error('Failed to start job:', r.jobid)
        throw new Error('Failed to start operation')
    }

    if (jobStatus.error) {
        console.error('Failed to start job:', r.jobid, jobStatus.error)
        throw new Error(jobStatus.error)
    }

    return r.jobid
}

export async function startBisync(args: BisyncArgs) {
    const [request] = buildBisyncRequests(args)
    const sourceExists = await hasStat(args.source, {
        configParam: request.body._config,
        remotes: args.options.remotes,
    })
    if (!sourceExists) {
        throw new Error(`Source does not exist, ${args.source} is missing`)
    }

    return submitAsyncQuery('/sync/bisync', request.body, {
        operation: 'bisync',
        sources: [args.source],
        destination: args.destination,
    })
}

export async function startSync(args: SyncArgs, isDryRun = false) {
    const [request] = buildSyncRequests(args)
    const sourceExists = await hasStat(args.source, {
        configParam: request.body._config,
        remotes: args.options.remotes,
    })
    if (!sourceExists) {
        throw new Error(`Source does not exist, ${args.source} is missing`)
    }

    return submitAsyncQuery(
        '/sync/sync',
        request.body,
        {
            operation: 'sync',
            sources: [args.source],
            destination: args.destination,
        },
        isDryRun
    )
}

export async function startDelete({ sources, options }: DeleteArgs, isDryRun = false) {
    const [request] = buildDeleteRequests({ sources, options })
    for (const source of sources) {
        const sourceExists = await hasStat(source, {
            configParam: request.body._config,
            remotes: options.remotes,
        })
        if (!sourceExists) {
            throw new Error(`Source does not exist, ${source} is missing`)
        }
    }

    return startBatch(
        request.body.inputs,
        { operation: 'delete', sources },
        { isDryRun, configParam: request.body._config }
    )
}

export async function startPurge({ sources, options }: PurgeArgs) {
    const [request] = buildPurgeRequests({ sources, options })
    for (const source of sources) {
        const sourceExists = await hasStat(source, {
            configParam: request.body._config,
            remotes: options.remotes,
        })
        if (!sourceExists) {
            throw new Error(`Source does not exist, ${source} is missing`)
        }
    }

    return startBatch(
        request.body.inputs,
        { operation: 'purge', sources },
        { configParam: request.body._config }
    )
}

export async function startServe({
    type,
    fs,
    addr,
    _filter,
    _config,
    ...props
}: {
    type: string
    fs: string
    addr: string
    _filter?: Record<string, FlagValue>
    _config?: Record<string, FlagValue>
} & Record<string, FlagValue>) {
    return rclone('/serve/start', {
        params: {
            query: {
                type,
                fs,
                addr,
                _filter: toFilterParam(_filter),
                _config: toConfigParam(_config),
                ...(props && Object.keys(props).length > 0
                    ? Object.fromEntries(
                          Object.entries(props).map(([key, value]) => [
                              key,
                              Array.isArray(value) ? value.join(',') : value,
                          ])
                      )
                    : {}),
            },
        },
    })
}

export async function startBatch(
    inputs: ({ _path: string } & Record<string, any>)[],
    meta?: Partial<Pick<WatchedJob, 'operation' | 'sources' | 'destination'>>,
    options?: { isDryRun?: boolean; configParam?: string }
) {
    console.log('[startBatch] starting batch operation', {
        inputCount: inputs.length,
        paths: inputs.map((i) => i._path),
    })
    console.log('[startBatch] inputs', JSON.stringify(inputs, null, 2))

    const r = await pRetry(
        async () =>
            await rclone('/job/batch', {
                body: {
                    inputs,
                    ...(options?.configParam ? { _config: options.configParam } : {}),
                    _async: true,
                },
            }),
        RETRY_OPTIONS
    )

    console.log('[startBatch] job created', { jobid: r.jobid })

    registerSubmittedJob(
        r.jobid,
        {
            operation: meta?.operation ?? 'batch',
            sources: meta?.sources,
            destination: meta?.destination,
        },
        options?.isDryRun ?? false
    )

    await new Promise((resolve) => setTimeout(resolve, 1000))

    const jobStatus = await pRetry(
        async () =>
            await rclone('/job/status', {
                params: {
                    query: {
                        jobid: r.jobid,
                    },
                },
            }),
        RETRY_OPTIONS
    ).catch(() => null)

    console.log('[startBatch] jobStatus', {
        jobid: r.jobid,
        finished: jobStatus?.finished,
        success: jobStatus?.success,
        error: jobStatus?.error,
    })
    console.log('[startBatch] jobStatus full', JSON.stringify(jobStatus, null, 2))

    if (!jobStatus) {
        console.error('[startBatch] ERROR: job status is null', { jobid: r.jobid })
        throw new Error('Failed to start operation')
    }

    const output = jobStatus.output as any
    if (
        output?.results &&
        Array.isArray(output.results) &&
        output.results.length === inputs.length
    ) {
        const results = output.results
        const allFailed = results.every((res: any) => res.error)

        if (allFailed) {
            const errorMessages = results
                .map((res: any) => {
                    const path = res.input?.srcRemote || res.input?.dstRemote || 'unknown'
                    return `${path}: ${res.error}`
                })
                .join('\n')

            console.error('[startBatch] ERROR: all batch operations failed', {
                jobid: r.jobid,
                errorMessages,
            })
            throw new Error(errorMessages)
        }
    }

    if (jobStatus.error) {
        console.error('[startBatch] ERROR: job failed', { jobid: r.jobid, error: jobStatus.error })
        throw new Error(jobStatus.error)
    }

    console.log('[startBatch] SUCCESS', { jobid: r.jobid })

    return r.jobid
}

/* PASSWORD */
export async function removeConfigPassword() {
    console.log('[removeConfigPassword]')

    const state = useHostStore.getState()
    const activeConfig = selectActiveConfigFile(state)

    if (!activeConfig || !activeConfig.id) {
        throw new Error('No active configuration selected.')
    }

    if (!activeConfig.isEncrypted) {
        throw new Error('Configuration is not encrypted.')
    }

    try {
        await runRcloneCli(['config', 'encryption', 'remove'])
        state.updateConfigFile(activeConfig.id, {
            isEncrypted: false,
            pass: undefined,
            passCommand: undefined,
        })
        console.log('[removeConfigPassword] restarting rclone')
        await restartActiveRclone()
    } catch (error) {
        Sentry.captureException(error)
        await message(error instanceof Error ? error.message : 'Failed to disable encryption.', {
            title: 'Config Encryption',
            kind: 'error',
            okLabel: 'OK',
        })
        throw error
    }
}

export async function setConfigPassword(options: {
    password: string
    persist?: boolean
}) {
    console.log('[setConfigPassword]')

    const state = useHostStore.getState()
    const activeConfig = selectActiveConfigFile(state)

    if (!activeConfig || !activeConfig.id) {
        throw new Error('No active configuration selected.')
    }

    const password = options.password

    if (!password) {
        throw new Error('Password is required to update encryption.')
    }

    try {
        await runRcloneCli(['config', 'encryption', 'set'], [password, password])
        state.updateConfigFile(activeConfig.id, {
            isEncrypted: true,
            pass: options.persist ? password : undefined,
            passCommand: undefined,
        })

        console.log('[setConfigPassword] restarting rclone')
        await restartActiveRclone()
    } catch (error) {
        Sentry.captureException(error)
        await message(
            error instanceof Error ? error.message : 'Failed to update encryption password.',
            {
                title: 'Config Encryption',
                kind: 'error',
                okLabel: 'OK',
            }
        )
        throw error
    }
}

/* RECONNECT */
export async function reconnectRemote(remoteName: string) {
    await rclone('/config/update', {
        params: {
            query: {
                name: remoteName,
                parameters: '{}',
            },
        },
    })
    await rclone('/fscache/clear')
}

/* OTHERS */
export async function fetchServeList() {
    try {
        const response = await rclone('/serve/list')
        return response.list
    } catch (error) {
        console.error('[fetchServeList] failed to fetch active serves', error)
        return []
    }
}

export async function fetchMountList() {
    try {
        const response = await rclone('/mount/listmounts')
        return response.mountPoints
    } catch (error) {
        console.error('[fetchMountList] failed to fetch active mounts', error)
        return []
    }
}

export async function uploadEmptyFile(fs: string, remote: string) {
    const currentHost = selectCurrentHost(usePersistedStore.getState())
    if (!currentHost) throw new Error('No current host')

    const authHeader = await getAuthHeader(currentHost)

    const body = new FormData()
    body.append('file0', new File([], '.empty'))

    const params = new URLSearchParams({ fs, remote })
    const response = await rcFetch(`${currentHost.url}/operations/uploadfile?${params}`, {
        method: 'POST',
        headers: authHeader ? { 'Authorization': authHeader } : undefined,
        body,
    })
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
    }
}
