import type { FlagValue } from '../../types/rclone'
import { getFsInfo } from '../format'
import { parsePath } from '../paths'

// Pure serialization of operation args into ready-to-POST rclone RC requests. This is the
// single source for BOTH the live start* path (lib/rclone/api.ts) and the scheduler's job
// specs — they can never diverge. No HTTP, no store access: paths are machine-local strings and
// save/run always happen on the same machine.

const RE_DASH = /-/g

function normalizeOptionName(name: string) {
    return (name.startsWith('--') ? name.slice(2) : name).replace(RE_DASH, '_')
}

function normalizeArrayValue(value: FlagValue): FlagValue {
    return Array.isArray(value) || value === null ? value : [String(value)]
}

// A blank (empty or whitespace-only) string means the user cleared the field, i.e. "unset". It
// must be dropped before building _config/_filter: rclone reshapes those params all-or-nothing, so
// a single blank in a typed field (Duration/SizeSuffix/int/…) rejects the ENTIRE param and fails
// the whole operation. Omitting the key is exactly what "unset" should mean.
function isBlankString(value: FlagValue): boolean {
    return typeof value === 'string' && value.trim() === ''
}

const FILTER_FIELD_NAMES: Record<string, string> = {
    filter: 'FilterRule',
    filter_from: 'FilterFrom',
    exclude: 'ExcludeRule',
    exclude_from: 'ExcludeFrom',
    include: 'IncludeRule',
    include_from: 'IncludeFrom',
    exclude_if_present: 'ExcludeFile',
    files_from: 'FilesFrom',
    files_from_raw: 'FilesFromRaw',
    delete_excluded: 'DeleteExcluded',
    min_age: 'MinAge',
    max_age: 'MaxAge',
    min_size: 'MinSize',
    max_size: 'MaxSize',
    ignore_case: 'IgnoreCase',
    hash_filter: 'HashFilter',
}

const METADATA_FILTER_FIELD_NAMES: Record<string, string> = {
    metadata_filter: 'FilterRule',
    metadata_filter_from: 'FilterFrom',
    metadata_exclude: 'ExcludeRule',
    metadata_exclude_from: 'ExcludeFrom',
    metadata_include: 'IncludeRule',
    metadata_include_from: 'IncludeFrom',
}

/**
 * The Metadata option section maps to two rc channels: the rule flags
 * (`metadata_include|exclude|filter[_from]`) belong in `_filter.MetaRules`, everything else
 * (`metadata`, `metadata_mapper`) in `_config`. The section is spread last, so the same flag
 * in another group never beats what the page shows.
 */
export function mergeMetadataOptions({
    config,
    filter,
    metadata,
}: {
    config?: Record<string, FlagValue>
    filter?: Record<string, FlagValue>
    metadata?: Record<string, FlagValue>
}): { config: Record<string, FlagValue>; filter: Record<string, FlagValue> } {
    const mergedConfig = { ...(config || {}) }
    const mergedFilter = { ...(filter || {}) }
    for (const [key, value] of Object.entries(metadata || {})) {
        if (normalizeOptionName(key) in METADATA_FILTER_FIELD_NAMES) {
            mergedFilter[key] = value
        } else {
            mergedConfig[key] = value
        }
    }
    return { config: mergedConfig, filter: mergedFilter }
}

const FILTER_ARRAY_OPTIONS = new Set([
    'filter',
    'filter_from',
    'exclude',
    'exclude_from',
    'include',
    'include_from',
    'exclude_if_present',
    'files_from',
    'files_from_raw',
    ...Object.keys(METADATA_FILTER_FIELD_NAMES),
])

export function toFilterParam(filter: Record<string, FlagValue> | undefined): string | undefined {
    if (!filter || Object.keys(filter).length === 0) {
        return undefined
    }

    const result: Record<string, FlagValue | Record<string, FlagValue>> = {}
    const metadataRules: Record<string, FlagValue> = {}

    for (const [key, value] of Object.entries(filter)) {
        if (isBlankString(value)) {
            continue
        }
        const normalized = normalizeOptionName(key)
        let normalizedValue = FILTER_ARRAY_OPTIONS.has(normalized)
            ? normalizeArrayValue(value)
            : value
        if (
            (normalized === 'min_age' || normalized === 'max_age') &&
            typeof normalizedValue === 'number' &&
            Number.isInteger(normalizedValue) &&
            !Number.isSafeInteger(normalizedValue)
        ) {
            normalizedValue = 'off'
        }
        const metadataFieldName = METADATA_FILTER_FIELD_NAMES[normalized]

        if (metadataFieldName) {
            metadataRules[metadataFieldName] = normalizedValue
        } else {
            result[FILTER_FIELD_NAMES[normalized] ?? key] = normalizedValue
        }
    }

    if (Object.keys(metadataRules).length > 0) {
        result.MetaRules = metadataRules
    }

    if (Object.keys(result).length === 0) {
        return undefined
    }

    return JSON.stringify(result)
}

const CONFIG_FIELD_NAMES: Record<string, string> = {
    contimeout: 'ConnectTimeout',
    no_check_certificate: 'InsecureSkipVerify',
    retries_sleep: 'RetriesInterval',
    update: 'UpdateOlder',
    no_gzip_encoding: 'NoGzip',
    fast_list: 'UseListR',
    stats_unit: 'DataRateUnit',
    use_cookies: 'Cookie',
    color: 'TerminalColorMode',
}

const CONFIG_ARRAY_OPTIONS = new Set(['compare_dest', 'copy_dest', 'ca_cert', 'name_transform'])
const CONFIG_SPACE_SEPARATED_OPTIONS = new Set(['password_command', 'metadata_mapper'])

export function toConfigParam(config: Record<string, FlagValue> | undefined): string | undefined {
    if (!config) {
        return undefined
    }
    const entries = Object.entries(config).filter(([, value]) => !isBlankString(value))
    if (entries.length === 0) {
        return undefined
    }
    return JSON.stringify(
        Object.fromEntries(
            entries.map(([key, value]) => {
                const normalized = normalizeOptionName(key)
                const fieldName =
                    CONFIG_FIELD_NAMES[normalized] ??
                    normalized
                        .split('_')
                        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                        .join('')
                let normalizedValue = value
                if (CONFIG_ARRAY_OPTIONS.has(normalized)) {
                    normalizedValue = normalizeArrayValue(value)
                } else if (
                    CONFIG_SPACE_SEPARATED_OPTIONS.has(normalized) &&
                    !Array.isArray(value) &&
                    value !== null
                ) {
                    normalizedValue = String(value).trim().split(/\s+/).filter(Boolean)
                }
                return [fieldName, normalizedValue]
            })
        )
    )
}

export interface CopyArgs {
    sources: string[]
    destination: string
    options: {
        copy?: Record<string, FlagValue>
        config?: Record<string, FlagValue>
        filter?: Record<string, FlagValue>
        metadata?: Record<string, FlagValue>
        remotes?: Record<string, Record<string, FlagValue>>
    }
}

export interface MoveArgs {
    sources: string[]
    destination: string
    options: {
        move?: Record<string, FlagValue>
        config?: Record<string, FlagValue>
        filter?: Record<string, FlagValue>
        metadata?: Record<string, FlagValue>
        remotes?: Record<string, Record<string, FlagValue>>
    }
}

export interface SyncArgs {
    source: string
    destination: string
    options: {
        config?: Record<string, FlagValue>
        sync?: Record<string, FlagValue>
        filter?: Record<string, FlagValue>
        metadata?: Record<string, FlagValue>
        remotes?: Record<string, Record<string, FlagValue>>
    }
}

export interface BisyncArgs {
    source: string
    destination: string
    options: {
        config?: Record<string, FlagValue>
        bisync?: Record<string, FlagValue>
        filter?: Record<string, FlagValue>
        metadata?: Record<string, FlagValue>
        remotes?: Record<string, Record<string, FlagValue>>
        outer?: Record<string, FlagValue>
    }
}

export interface DeleteArgs {
    sources: string[]
    options: {
        filter?: Record<string, FlagValue>
        config?: Record<string, FlagValue>
        metadata?: Record<string, FlagValue>
        remotes?: Record<string, Record<string, FlagValue>>
    }
}

export interface PurgeArgs {
    sources: string[]
    options: {
        config?: Record<string, FlagValue>
        remotes?: Record<string, Record<string, FlagValue>>
    }
}

export type BatchInput = { _path: string } & Record<string, any>

export interface RcRequest {
    endpoint: '/job/batch' | '/sync/sync' | '/sync/bisync'
    // Always body-form with `_async: true`: a scheduled run hands these over verbatim (rclone's
    // RC treats body and query parameters identically). The live path converts back to the
    // query form its client uses.
    body: Record<string, any>
}

// Encodes a path as an rclone connection string with inlined per-remote options:
// "<remoteName>,<k>=\"v\":<path>".
export function serializeOptions(
    remotePath: string,
    options: {
        remote?: Record<string, FlagValue>
    }
) {
    const { remoteName, filePath, dirPath, type, root } = getFsInfo(remotePath)
    // Options the path already carried (a record's fs string) stay ahead of the ones added.
    const parsed = parsePath(remotePath)
    const params = parsed.kind === 'remote' ? parsed.params : ''

    let serialized = `${remoteName}${params}`

    if (options.remote && Object.keys(options.remote).length > 0) {
        serialized += ','
        serialized += Object.entries(options.remote)
            .map(([key, value]) => `${key}="${value}"`)
            .join(',')
    }

    serialized += ':'

    // What the root carries after its colon: nothing, the user's leading slash (`gdrive:/`,
    // absolute on sftp), or a local root (`/`, `C:/`). The path is relative to it.
    serialized += root.slice(remoteName.length + params.length + 1)

    if (type === 'folder') {
        serialized += dirPath
    } else {
        serialized += filePath
    }

    return serialized
}

// Names of the filter options the user actually set — blank (cleared) values are treated as unset
// here exactly as toFilterParam drops them, so a cleared field never trips these guards.
function activeFilterNames(filter?: Record<string, FlagValue>): Set<string> {
    return new Set(
        Object.entries(filter || {})
            .filter(([, value]) => !isBlankString(value))
            .map(([key]) => normalizeOptionName(key))
    )
}

function assertIncludeRules(sources: string[], filter?: Record<string, FlagValue>) {
    const filterNames = activeFilterNames(filter)
    if (sources.length > 1 && (filterNames.has('include') || filterNames.has('include_from'))) {
        throw new Error('Include rules are not supported with multiple sources')
    }
}

export type PathKind = 'file' | 'folder'
/** What each source path is, by the path as given: rclone's answer (`describeSources`). */
export type Kinds = Record<string, PathKind>

/**
 * Whether a source is a file or a folder: rclone's answer when there is one, else the only hint
 * a string carries, its trailing separator. A trailing slash is spelling, not a signal — the
 * app adds none — so a build without an answer (a pure build) reads the spelling and nothing
 * else, and a start always asks first.
 */
export function kindOf(path: string, kinds?: Kinds): PathKind {
    return kinds?.[path] ?? getFsInfo(path).type
}

const TRAILING_SEPARATORS = /[/\\]+$/

/** A source that is inside a folder that is also a source, slash or no slash on either. */
function isInsideAFolderSource(source: string, folders: string[]) {
    return folders.some((folder) =>
        source.startsWith(`${folder.replace(TRAILING_SEPARATORS, '')}/`)
    )
}

function assertFolderFilters(
    sources: string[],
    filter: Record<string, FlagValue> | undefined,
    kinds: Kinds | undefined
) {
    if (
        activeFilterNames(filter).size > 0 &&
        sources.some((path) => kindOf(path, kinds) !== 'folder')
    ) {
        throw new Error('Filters are only supported when every selected source is a folder')
    }
}

function remoteOptionsFor(
    remotes: Record<string, Record<string, FlagValue>> | undefined,
    remoteName: string | undefined
) {
    return remotes && remoteName && remoteName in remotes ? remotes[remoteName] : undefined
}

// Shared fan-out for copy/move: one batch input per source, de-duping repeats and children of
// folder sources, with the folder/file split deciding the RC method.
/** An fs string with the remote's per-operation overrides folded in, or as it is. */
function withRemote(
    fs: string,
    remotes: Record<string, Record<string, FlagValue>> | undefined,
    remoteName: string | undefined
) {
    return serializeOptions(fs, { remote: remoteOptionsFor(remotes, remoteName) })
}

/**
 * The `_config` and `_filter` of an operation: its own option group under the config group
 * (config wins), metadata routed into both. With `sources`, the filter rules that only hold
 * for folders are checked against them first.
 */
function operationParams(
    own: Record<string, FlagValue> | undefined,
    options: {
        config?: Record<string, FlagValue>
        filter?: Record<string, FlagValue>
        metadata?: Record<string, FlagValue>
    },
    sources?: string[],
    kinds?: Kinds
) {
    const merged = mergeMetadataOptions({
        config: { ...(own || {}), ...(options.config || {}) },
        filter: options.filter,
        metadata: options.metadata,
    })
    if (sources) {
        assertIncludeRules(sources, merged.filter)
        assertFolderFilters(sources, merged.filter, kinds)
    }
    const configParam = toConfigParam(merged.config)
    const filterParam = toFilterParam(merged.filter)
    return {
        configParam,
        filterParam,
        params: {
            ...(configParam ? { _config: configParam } : {}),
            ...(filterParam ? { _filter: filterParam } : {}),
        },
    }
}

/** One `/job/batch` of `inputs`, the config repeated at the batch level as rclone expects. */
function batchRequest(inputs: BatchInput[], configParam: string | undefined): RcRequest[] {
    return [
        {
            endpoint: '/job/batch',
            body: {
                inputs,
                ...(configParam ? { _config: configParam } : {}),
                _async: true,
            },
        },
    ]
}

function buildTransferInputs(
    args: CopyArgs | MoveArgs,
    paths: { folder: string; file: string },
    configParam: string | undefined,
    filterParam: string | undefined,
    kinds: Kinds | undefined
): BatchInput[] {
    const { sources, destination, options } = args

    const inputs: BatchInput[] = []
    const handledSourcePaths: Record<string, true> = {}
    const folderSources = sources.filter((path) => kindOf(path, kinds) === 'folder')

    const {
        root: dstRoot,
        dirPath: dstDirPath,
        fullDirPath: dstFullDirPath,
        remoteName: dstRemoteName,
    } = getFsInfo(destination)

    const dstOptions = remoteOptionsFor(options.remotes, dstRemoteName)

    for (const source of sources) {
        if (handledSourcePaths[source]) {
            console.log('[buildTransferInputs] skipping already handled source', source)
            continue
        }

        handledSourcePaths[source] = true

        const {
            root: srcRoot,
            filePath: srcFilePath,
            fullDirPath: srcFullDirPath,
            name: srcName,
            remoteName: srcRemoteName,
        } = getFsInfo(source)

        const srcOptions = remoteOptionsFor(options.remotes, srcRemoteName)

        if (kindOf(source, kinds) === 'folder') {
            inputs.push({
                _path: paths.folder,
                srcFs: serializeOptions(srcFullDirPath, {
                    remote: srcOptions,
                }),
                dstFs: serializeOptions(`${dstFullDirPath}${srcName}`, {
                    remote: dstOptions,
                }),
                createEmptySrcDirs: true,
                ...(configParam ? { _config: configParam } : {}),
                ...(filterParam ? { _filter: filterParam } : {}),
            })
            continue
        }

        if (isInsideAFolderSource(source, folderSources)) {
            console.log('[buildTransferInputs] skipping child of handled folder', source)
            continue
        }

        inputs.push({
            _path: paths.file,
            srcFs: serializeOptions(srcRoot, {
                remote: srcOptions,
            }),
            ...(configParam ? { _config: configParam } : {}),
            srcRemote: srcFilePath,
            dstFs: serializeOptions(dstRoot, {
                remote: dstOptions,
            }),
            dstRemote: `${dstDirPath === '/' ? '' : dstDirPath}${srcName}`,
        })
    }

    return inputs
}

export function buildCopyRequests(args: CopyArgs, kinds?: Kinds): RcRequest[] {
    const { configParam, filterParam } = operationParams(
        args.options.copy,
        args.options,
        args.sources,
        kinds
    )
    const inputs = buildTransferInputs(
        args,
        { folder: 'sync/copy', file: 'operations/copyfile' },
        configParam,
        filterParam,
        kinds
    )
    return batchRequest(inputs, configParam)
}

export function buildMoveRequests(args: MoveArgs, kinds?: Kinds): RcRequest[] {
    const { configParam, filterParam } = operationParams(
        args.options.move,
        args.options,
        args.sources,
        kinds
    )
    const inputs = buildTransferInputs(
        args,
        { folder: 'sync/move', file: 'operations/movefile' },
        configParam,
        filterParam,
        kinds
    )
    return batchRequest(inputs, configParam)
}

/** A sync or a bisync takes folders; with an answer in hand, a file is refused by name. */
function assertFolderSource(source: string, kinds: Kinds | undefined, needs: string) {
    if (kinds && kindOf(source, kinds) !== 'folder') {
        throw new Error(`${source} is a file; ${needs}`)
    }
}

export function buildSyncRequests(args: SyncArgs, kinds?: Kinds): RcRequest[] {
    const { source, destination, options } = args
    assertFolderSource(source, kinds, 'a sync needs a folder')
    const { params } = operationParams(options.sync, options)
    const src = getFsInfo(source)
    const dst = getFsInfo(destination)
    return [
        {
            endpoint: '/sync/sync',
            body: {
                srcFs: withRemote(src.fullDirPath, options.remotes, src.remoteName),
                dstFs: withRemote(dst.fullDirPath, options.remotes, dst.remoteName),
                createEmptySrcDirs: true,
                ...params,
                _async: true,
            },
        },
    ]
}

export function buildBisyncRequests(args: BisyncArgs, kinds?: Kinds): RcRequest[] {
    const { source, destination, options } = args
    assertFolderSource(source, kinds, 'a bisync needs two folders')
    const { params } = operationParams(options.bisync, options)
    const src = getFsInfo(source)
    const dst = getFsInfo(destination)
    return [
        {
            endpoint: '/sync/bisync',
            body: {
                path1: withRemote(src.fullDirPath, options.remotes, src.remoteName),
                path2: withRemote(dst.fullDirPath, options.remotes, dst.remoteName),
                ...params,
                ...(options.outer && Object.keys(options.outer).length > 0
                    ? Object.fromEntries(
                          Object.entries(options.outer).map(([key, value]) => [
                              key,
                              Array.isArray(value) ? value.join(',') : value,
                          ])
                      )
                    : {}),
                _async: true,
            },
        },
    ]
}

export function buildDeleteRequests(args: DeleteArgs, kinds?: Kinds): RcRequest[] {
    const { sources, options } = args
    const { configParam, params } = operationParams(undefined, options, sources, kinds)

    const inputs: BatchInput[] = []
    const handledSourcePaths: Record<string, true> = {}
    const folderSources = sources.filter((path) => kindOf(path, kinds) === 'folder')

    for (const source of sources) {
        if (handledSourcePaths[source]) {
            console.log('[buildDeleteRequests] skipping already handled source', source)
            continue
        }

        handledSourcePaths[source] = true

        const {
            root: srcRoot,
            filePath: srcFilePath,
            remoteName: srcRemoteName,
        } = getFsInfo(source)

        if (kindOf(source, kinds) === 'folder') {
            inputs.push({
                _path: 'operations/delete',
                fs: withRemote(source, options.remotes, srcRemoteName),
                ...params,
            })
            continue
        }

        if (isInsideAFolderSource(source, folderSources)) {
            console.log('[buildDeleteRequests] skipping child of handled folder', source)
            continue
        }

        inputs.push({
            _path: 'operations/deletefile',
            fs: withRemote(srcRoot, options.remotes, srcRemoteName),
            ...(configParam ? { _config: configParam } : {}),
            remote: srcFilePath,
        })
    }

    return batchRequest(inputs, configParam)
}

export function buildPurgeRequests(args: PurgeArgs, kinds?: Kinds): RcRequest[] {
    const { sources, options } = args

    // A purge takes no filters and no metadata: the config group alone.
    const configParam = toConfigParam(options.config || {})
    const inputs: BatchInput[] = []
    const handledSourcePaths: Record<string, true> = {}

    for (const source of sources) {
        if (handledSourcePaths[source]) {
            console.log('[buildPurgeRequests] skipping already handled source', source)
            continue
        }

        handledSourcePaths[source] = true

        const { root: srcRoot, filePath: srcDirPath, remoteName: srcRemoteName } = getFsInfo(source)

        if (kindOf(source, kinds) !== 'folder') {
            throw new Error(`${source} is a file; only folders can be purged`)
        }

        inputs.push({
            _path: 'operations/purge',
            fs: withRemote(srcRoot, options.remotes, srcRemoteName),
            ...(configParam ? { _config: configParam } : {}),
            remote: srcDirPath,
        })
    }

    return batchRequest(inputs, configParam)
}

/** Discriminated operation/args pair — ScheduledTask satisfies this. */
export type TaskRequestInput =
    | { operation: 'copy'; args: CopyArgs }
    | { operation: 'move'; args: MoveArgs }
    | { operation: 'sync'; args: SyncArgs }
    | { operation: 'bisync'; args: BisyncArgs }
    | { operation: 'delete'; args: DeleteArgs }
    | { operation: 'purge'; args: PurgeArgs }

/** Builds the RC requests for a scheduled task — throws when the args can't serialize. */
export function buildTaskRequests(task: TaskRequestInput, kinds?: Kinds): RcRequest[] {
    switch (task.operation) {
        case 'copy':
            return buildCopyRequests(task.args, kinds)
        case 'move':
            return buildMoveRequests(task.args, kinds)
        case 'sync':
            return buildSyncRequests(task.args, kinds)
        case 'bisync':
            return buildBisyncRequests(task.args, kinds)
        case 'delete':
            return buildDeleteRequests(task.args, kinds)
        case 'purge':
            return buildPurgeRequests(task.args, kinds)
        default:
            throw new Error(`Unknown operation: ${(task as { operation: string }).operation}`)
    }
}

/**
 * The `_config` an operation's requests will carry, for the stat that asks what its sources
 * are: the same options, before any request exists. No source is checked here (that is the
 * build's, once the answer is in).
 */
export function configParamOf(task: TaskRequestInput): string | undefined {
    const { options } = task.args
    switch (task.operation) {
        case 'copy':
            return operationParams(task.args.options.copy, options).configParam
        case 'move':
            return operationParams(task.args.options.move, options).configParam
        case 'sync':
            return operationParams(task.args.options.sync, options).configParam
        case 'bisync':
            return operationParams(task.args.options.bisync, options).configParam
        case 'delete':
            return operationParams(undefined, options).configParam
        case 'purge':
            return toConfigParam(options.config || {})
        default:
            throw new Error(`Unknown operation: ${(task as { operation: string }).operation}`)
    }
}
