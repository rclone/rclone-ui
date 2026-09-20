// How a transfer starts. Every one goes through `submit`: the server puts the request to rclone
// and records the transfer in one step (`transfers_start`), so rclone never runs something the
// record has not heard of. The operation pages, the Commander and the Wizard start theirs here;
// a mount is no transfer (pages/Mount/startMount.ts), and a retry or a download builds its own
// request beside its page.

import { UserCancelledError } from '@/lib/errors'
import { type TransferStart, type TransferTag, transfersStart } from '@/server/transfers'
import rclone from './client'
import { handleReconnectIfNeeded } from './health'
import { describeSources } from './kinds'
import type { OperationPreset, PresetFor, PresetOperation } from './preset'
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
    toConfigParam,
    toFilterParam,
} from './requests'
import type { FlagValue } from './types'

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

// Copy and move are one operation modulo the word.
const COPY_OR_MOVE = { copy: buildCopyRequests, move: buildMoveRequests }

async function startCopyOrMove(
    operation: 'copy' | 'move',
    args: CopyArgs,
    isDryRun: boolean,
    extra?: StartExtra
) {
    const kinds = await askAbout({ operation, args } as TaskRequestInput, args.sources)
    const [request] = COPY_OR_MOVE[operation](args, kinds)

    return startBatch(
        request.body.inputs,
        { operation, sources: args.sources, destination: args.destination },
        {
            isDryRun,
            configParam: request.body._config,
            preset: presetOf(operation, args, extra),
            tags: extra?.tags,
        }
    )
}

export const startCopy = (args: CopyArgs, isDryRun = false, extra?: StartExtra) =>
    startCopyOrMove('copy', args, isDryRun, extra)
export const startMove = (args: MoveArgs, isDryRun = false, extra?: StartExtra) =>
    startCopyOrMove('move', args, isDryRun, extra)

// Every transfer starts here. The server submits the request to rclone and records the transfer
// in one step (`transfers_start`), so there is no moment where rclone runs something the record
// has not heard of; a launch that dies within its first second comes back as this call's error.
// The request is the builders' own body form, the same one a scheduled run submits.
export async function submit(
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

