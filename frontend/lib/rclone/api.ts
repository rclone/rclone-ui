import pRetry from 'p-retry'
import {
    type TransferDetail,
    type TransferEntry,
    type TransferStart,
    type TransferTag,
    transfersStart,
} from '../api/transfers'
import { type RetryItem, retryRequest } from '../transfers/retry'
import { rcFetch } from '../api/rc'
import type { MountArgs, OperationPreset, PresetFor, PresetOperation } from './preset'
import type { FlagValue } from '../../types/rclone'
import { UserCancelledError, formatErrorMessage } from '../errors'
import { getFsInfo } from '../format'
import { dispatchNotification } from '../notifications'
import rclone, { currentHostOs, handleReconnectIfNeeded, isHostWindows } from './client'
import {
    type BisyncArgs,
    type CopyArgs,
    type DeleteArgs,
    type MoveArgs,
    type PurgeArgs,
    type SyncArgs,
    type TaskRequestInput,
    buildBisyncRequests,
    buildCopyRequests,
    buildDeleteRequests,
    buildMoveRequests,
    buildPurgeRequests,
    buildSyncRequests,
    configParamOf,
    mergeMetadataOptions,
    serializeOptions,
    toConfigParam,
    toFilterParam,
} from './requests'
import { describeSources } from './kinds'
import { attendLogin, loginParameters, presentSignIn, stopStrayOAuth } from './oauth'

const RE_BACKSLASH = /\\/g
const RE_DASH = /-/g
const RE_PATH_SEPARATOR = /[/\\]/
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

/** What the page had on besides the args, kept with the job's record. */
export interface StartExtra {
    cron?: string | null
    /** Where the transfer comes from, when that is not an operation's page. */
    tags?: TransferTag[]
}

function presetOf<O extends PresetOperation>(
    operation: O,
    args: PresetFor<O>['args'],
    extra?: StartExtra
): OperationPreset {
    return { operation, args, ...(extra?.cron ? { cron: extra.cron } : {}) } as OperationPreset
}

// A dry run's record must not reopen as a dry run.
function withoutDryRun(preset: OperationPreset): OperationPreset {
    const args = preset.args as { options?: { config?: Record<string, FlagValue> } }
    const config = args.options?.config
    if (!config || !('dry_run' in config)) return preset
    const { dry_run: _dryRun, ...rest } = config
    return {
        ...preset,
        args: { ...args, options: { ...args.options, config: rest } },
    } as OperationPreset
}

/**
 * What the sources are, from rclone, before a request is built from them: "does not exist"
 * for a missing one, and file or folder for the rest, which decides the endpoint. The stat
 * carries the operation's own `_config`, the same one its requests will.
 */
function askAbout(task: TaskRequestInput, sources: string[]) {
    return describeSources(sources, {
        configParam: configParamOf(task),
        remotes: task.args.options.remotes,
    })
}

export async function startCopy(args: CopyArgs, isDryRun = false, extra?: StartExtra) {
    console.log('[startCopy] starting', {
        sources: args.sources,
        destination: args.destination,
        optionKeys: Object.keys(args.options),
    })

    const kinds = await askAbout({ operation: 'copy', args }, args.sources)
    const [request] = buildCopyRequests(args, kinds)

    console.log('[startCopy] submitting batch', { jobCount: request.body.inputs.length })
    return startBatch(
        request.body.inputs,
        {
            operation: 'copy',
            sources: args.sources,
            destination: args.destination,
        },
        {
            isDryRun,
            configParam: request.body._config,
            preset: presetOf('copy', args, extra),
            tags: extra?.tags,
        }
    )
}

export async function startMove(args: MoveArgs, isDryRun = false, extra?: StartExtra) {
    console.log('[startMove] starting', {
        sources: args.sources,
        destination: args.destination,
        optionKeys: Object.keys(args.options),
    })

    const kinds = await askAbout({ operation: 'move', args }, args.sources)
    const [request] = buildMoveRequests(args, kinds)

    console.log('[startMove] submitting batch', { jobCount: request.body.inputs.length })
    return startBatch(
        request.body.inputs,
        {
            operation: 'move',
            sources: args.sources,
            destination: args.destination,
        },
        {
            isDryRun,
            configParam: request.body._config,
            preset: presetOf('move', args, extra),
            tags: extra?.tags,
        }
    )
}

/* OPERATIONS */
// Wraps the mount flow so a failure emits the mount.failed webhook event. Rethrows for the
// caller's own handling.
export async function startMount(params: MountArgs) {
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

async function startMountInner({ source, destination, options }: MountArgs) {
    // The mount happens where the daemon runs: the selected host's OS, not the page server's.
    const currentPlatform = currentHostOs()
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
    const merged = mergeMetadataOptions({
        config: options.config,
        filter: options.filter,
        metadata: options.metadata,
    })
    const configParam = toConfigParam(merged.config)
    const filterParam = toFilterParam(merged.filter)

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

    const dstFs = dstRoot
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

    // The mount happens where the daemon runs: the selected host's OS, not the page server's.
    const isPlatformWindows = isHostWindows()

    if (directoryExists) {
        let isEmpty = false
        try {
            const { list } = await pRetry(
                async () =>
                    await rclone('/operations/list', {
                        params: {
                            query: {
                                fs: dstRoot,
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
                                    fs: dstRoot,
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
                                fs: dstRoot,
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
                            // The root carries its own slash (`:local:/…`), so the backend's
                            // name comes off and nothing goes on.
                            if (!isHostWindows()) {
                                return dstFullDirPath.replace(':local:', '')
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

// Every transfer starts here. The server submits the request to rclone and records the transfer
// in one step (`transfers_start`), so there is no moment where rclone runs something the record
// has not heard of; a launch that dies within its first second comes back as this call's error.
// The request is the builders' own body form, the same one a scheduled run submits.
async function submit(
    request: { endpoint: string; body: Record<string, any> },
    meta: Pick<TransferStart, 'operation' | 'sources' | 'destination'>,
    {
        isDryRun = false,
        preset,
        retryOf,
        // Where it comes from. Everything that does not say is an operation's page.
        tags = ['operation'],
    }: {
        isDryRun?: boolean
        preset?: OperationPreset
        retryOf?: string
        tags?: TransferTag[]
    } = {}
) {
    try {
        return await transfersStart({
            ...meta,
            isDryRun,
            // A dry run's record must not reopen as a dry run.
            preset: preset && isDryRun ? withoutDryRun(preset) : preset,
            retryOf,
            tags,
            request,
        })
    } catch (error) {
        // rclone's errors reach the page through its client, which offers to reconnect a remote
        // whose sign-in has lapsed. This one comes from the server instead, so it is shown the
        // same door: a launch that died on an expired token asks, as it always did.
        const text = error instanceof Error ? error.message : String(error)
        if (await handleReconnectIfNeeded(text)) throw new UserCancelledError(text)
        throw error
    }
}

/**
 * Retries a selection of a transfer's failures as one new transfer (`lib/transfers/retry.ts`
 * says what can be retried and how). It keeps what the original was: its operation, its
 * destination, its settings and whether it was a dry run; its sources are what is retried.
 */
export async function startRetry(of: TransferEntry, items: RetryItem[], detail: TransferDetail) {
    return submit(
        retryRequest(items, detail),
        {
            operation: of.operation,
            sources: items.map((item) => item.source),
            destination: of.destination,
        },
        {
            isDryRun: of.isDryRun,
            preset: of.preset as OperationPreset | undefined,
            retryOf: of.id,
            // A retry comes from where what it retries came from.
            tags: of.tags as TransferTag[],
        }
    )
}

/**
 * A download from a URL into `fs`, as `remote`: rclone's `operations/copyurl`, as a batch of one
 * input so that it starts where every other transfer does and is recorded like one.
 */
export async function startDownload({
    url,
    fs,
    remote,
}: { url: string; fs: string; remote: string }) {
    return submit(
        {
            endpoint: '/job/batch',
            body: {
                inputs: [{ _path: 'operations/copyurl', fs, remote, url, autoFilename: false }],
                _async: true,
            },
        },
        {
            operation: 'download',
            sources: [url],
            destination: /[/\\:]$/.test(fs) ? `${fs}${remote}` : `${fs}/${remote}`,
        }
    )
}

export async function startBisync(args: BisyncArgs, extra?: StartExtra) {
    const kinds = await askAbout({ operation: 'bisync', args }, [args.source])
    const [request] = buildBisyncRequests(args, kinds)

    return submit(
        request,
        { operation: 'bisync', sources: [args.source], destination: args.destination },
        { preset: presetOf('bisync', args, extra) }
    )
}

export async function startSync(args: SyncArgs, isDryRun = false, extra?: StartExtra) {
    const kinds = await askAbout({ operation: 'sync', args }, [args.source])
    const [request] = buildSyncRequests(args, kinds)

    return submit(
        request,
        {
            operation: 'sync',
            sources: [args.source],
            destination: args.destination,
        },
        { isDryRun, preset: presetOf('sync', args, extra) }
    )
}

export async function startDelete(
    { sources, options }: DeleteArgs,
    isDryRun = false,
    extra?: StartExtra
) {
    const kinds = await askAbout({ operation: 'delete', args: { sources, options } }, sources)
    const [request] = buildDeleteRequests({ sources, options }, kinds)

    return startBatch(
        request.body.inputs,
        { operation: 'delete', sources },
        {
            isDryRun,
            configParam: request.body._config,
            preset: presetOf('delete', { sources, options }, extra),
        }
    )
}

export async function startPurge({ sources, options }: PurgeArgs, extra?: StartExtra) {
    const kinds = await askAbout({ operation: 'purge', args: { sources, options } }, sources)
    const [request] = buildPurgeRequests({ sources, options }, kinds)

    return startBatch(
        request.body.inputs,
        { operation: 'purge', sources },
        {
            configParam: request.body._config,
            preset: presetOf('purge', { sources, options }, extra),
        }
    )
}

export async function startServe({
    type,
    fs,
    addr,
    _filter,
    _config,
    _metadata,
    ...props
}: {
    type: string
    fs: string
    addr: string
    _filter?: Record<string, FlagValue>
    _config?: Record<string, FlagValue>
    _metadata?: Record<string, FlagValue>
} & Record<string, FlagValue>) {
    const merged = mergeMetadataOptions({ config: _config, filter: _filter, metadata: _metadata })
    return rclone('/serve/start', {
        params: {
            query: {
                type,
                fs,
                addr,
                _filter: toFilterParam(merged.filter),
                _config: toConfigParam(merged.config),
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
    meta?: Partial<Pick<TransferStart, 'operation' | 'sources' | 'destination'>>,
    options?: {
        isDryRun?: boolean
        configParam?: string
        preset?: OperationPreset
        tags?: TransferTag[]
    }
) {
    return submit(
        {
            endpoint: '/job/batch',
            body: {
                inputs,
                ...(options?.configParam ? { _config: options.configParam } : {}),
                _async: true,
            },
        },
        {
            operation: meta?.operation ?? 'batch',
            sources: meta?.sources,
            destination: meta?.destination,
        },
        { isDryRun: options?.isDryRun, preset: options?.preset, tags: options?.tags }
    )
}

/* RECONNECT */
// Runs the backend's login again. The update blocks while rclone waits; a login somebody walked
// away from is stopped first. The daemon opens no browser: a dialog offers the sign-in link to
// open or copy, and its Cancel stops the login.
export async function reconnectRemote(remoteName: string) {
    await stopStrayOAuth()
    await attendLogin(
        () =>
            rclone('/config/update', {
                params: {
                    query: {
                        name: remoteName,
                        parameters: JSON.stringify(loginParameters()),
                    },
                },
            }),
        {
            onAuthUrl: (url) => {
                presentSignIn(url, { what: remoteName }).catch((error: unknown) =>
                    console.warn('[reconnectRemote] sign-in dialog', error)
                )
            },
        }
    )
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
    const body = new FormData()
    body.append('file0', new File([], '.empty'))

    const params = new URLSearchParams({ fs, remote })
    const response = await rcFetch(`operations/uploadfile?${params}`, {
        method: 'POST',
        body,
    })
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
    }
}
