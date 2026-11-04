import type { FlagValue } from '../../types/rclone'
import { getFsInfo } from '../format'

// Pure serialization of operation args into ready-to-POST rclone RC requests. This is the
// single source for BOTH the live start* path (lib/rclone/api.ts) and the scheduler's job
// specs — they can never diverge. No HTTP, no store access: paths are machine-local strings and
// save/run always happen on the same machine.

const RE_WINDOWS_DRIVE_ROOT = /^:local:[a-zA-Z]:\/$/
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
        remotes?: Record<string, Record<string, FlagValue>>
        // sync/move's own parameters, not config flags. createEmptySrcDirs defaults to true when unset.
        outer?: MoveOuterOptions
    }
}

export interface MoveOuterOptions {
    createEmptySrcDirs?: boolean
    deleteEmptySrcDirs?: boolean
}

export interface SyncArgs {
    source: string
    destination: string
    options: {
        config?: Record<string, FlagValue>
        sync?: Record<string, FlagValue>
        filter?: Record<string, FlagValue>
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
        remotes?: Record<string, Record<string, FlagValue>>
        outer?: Record<string, FlagValue>
    }
}

export interface DeleteArgs {
    sources: string[]
    options: {
        filter?: Record<string, FlagValue>
        config?: Record<string, FlagValue>
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
    // Always body-form with `_async: true`: the headless runner POSTs these verbatim (rclone's
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
    console.log('[serializeRemoteOptions] ', remotePath)

    const { remoteName, filePath, dirPath, type, root } = getFsInfo(remotePath)

    console.log('[serializeRemoteOptions] ', remotePath, 'remoteName', remoteName)
    console.log('[serializeRemoteOptions] ', remotePath, 'filePath', filePath)
    console.log('[serializeRemoteOptions] ', remotePath, 'dirPath', dirPath)
    console.log('[serializeRemoteOptions] ', remotePath, 'type', type)
    console.log('[serializeRemoteOptions] ', remotePath, 'root', root)

    let serialized = `${remoteName}`

    if (Object.keys(options.remote || {}).length > 0) {
        serialized += ','
    }

    if (options.remote && Object.keys(options.remote).length > 0) {
        serialized += Object.entries(options.remote)
            .map(([key, value]) => `${key}="${value}"`)
            .join(',')
    }

    serialized += ':'

    if (remoteName === ':local') {
        if (RE_WINDOWS_DRIVE_ROOT.test(root)) {
            const driveLetter = root.slice(7)
            console.log(
                '[serializeRemoteOptions] ',
                remotePath,
                'adding Windows drive',
                driveLetter
            )
            serialized += driveLetter
        } else {
            console.log('[serializeRemoteOptions] ', remotePath, 'adding / for Unix local')
            serialized += '/'
        }
    }

    if (type === 'folder') {
        serialized += dirPath
    } else {
        serialized += filePath
    }

    console.log('[serializeRemoteOptions] ', remotePath, 'serialized', serialized)

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

function assertFolderFilters(sources: string[], filter?: Record<string, FlagValue>) {
    if (
        activeFilterNames(filter).size > 0 &&
        sources.some((path) => !path.endsWith('/') && !path.endsWith('\\'))
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
function buildTransferInputs(
    args: CopyArgs | MoveArgs,
    paths: { folder: string; file: string },
    configParam: string | undefined,
    filterParam: string | undefined,
    // Extra parameters for folder sources only: operations/copyfile and operations/movefile take none of them.
    folderParams: Record<string, boolean>
): BatchInput[] {
    const { sources, destination, options } = args

    const inputs: BatchInput[] = []
    const handledSourcePaths: Record<string, true> = {}
    const folderSources = sources.filter((path) => path.endsWith('/') || path.endsWith('\\'))

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
            type: srcType,
            name: srcName,
            remoteName: srcRemoteName,
        } = getFsInfo(source)

        const srcOptions = remoteOptionsFor(options.remotes, srcRemoteName)

        if (srcType === 'folder') {
            inputs.push({
                _path: paths.folder,
                srcFs: serializeOptions(srcFullDirPath, {
                    remote: srcOptions,
                }),
                dstFs: serializeOptions(`${dstFullDirPath}${srcName}`, {
                    remote: dstOptions,
                }),
                ...folderParams,
                ...(configParam ? { _config: configParam } : {}),
                ...(filterParam ? { _filter: filterParam } : {}),
            })
            continue
        }

        if (folderSources.some((folder) => source.startsWith(folder))) {
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

export function buildCopyRequests(args: CopyArgs): RcRequest[] {
    assertIncludeRules(args.sources, args.options.filter)
    assertFolderFilters(args.sources, args.options.filter)
    const configParam = toConfigParam({
        ...(args.options.copy || {}),
        ...(args.options.config || {}),
    })
    const filterParam = toFilterParam(args.options.filter)
    const inputs = buildTransferInputs(
        args,
        { folder: 'sync/copy', file: 'operations/copyfile' },
        configParam,
        filterParam,
        { createEmptySrcDirs: true }
    )
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

export function buildMoveRequests(args: MoveArgs): RcRequest[] {
    assertIncludeRules(args.sources, args.options.filter)
    assertFolderFilters(args.sources, args.options.filter)
    const configParam = toConfigParam({
        ...(args.options.move || {}),
        ...(args.options.config || {}),
    })
    const filterParam = toFilterParam(args.options.filter)
    const inputs = buildTransferInputs(
        args,
        { folder: 'sync/move', file: 'operations/movefile' },
        configParam,
        filterParam,
        {
            createEmptySrcDirs: args.options.outer?.createEmptySrcDirs ?? true,
            ...(args.options.outer?.deleteEmptySrcDirs ? { deleteEmptySrcDirs: true } : {}),
        }
    )
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

export function buildSyncRequests(args: SyncArgs): RcRequest[] {
    const { source, destination, options } = args

    const configParam = toConfigParam({ ...(options.sync || {}), ...(options.config || {}) })
    const filterParam = toFilterParam(options.filter)

    const { fullDirPath: srcFullDirPath, remoteName: srcRemoteName } = getFsInfo(source)
    const { fullDirPath: dstFullDirPath, remoteName: dstRemoteName } = getFsInfo(destination)

    return [
        {
            endpoint: '/sync/sync',
            body: {
                srcFs: serializeOptions(srcFullDirPath, {
                    remote: remoteOptionsFor(options.remotes, srcRemoteName),
                }),
                dstFs: serializeOptions(dstFullDirPath, {
                    remote: remoteOptionsFor(options.remotes, dstRemoteName),
                }),
                createEmptySrcDirs: true,
                ...(configParam ? { _config: configParam } : {}),
                ...(filterParam ? { _filter: filterParam } : {}),
                _async: true,
            },
        },
    ]
}

export function buildBisyncRequests(args: BisyncArgs): RcRequest[] {
    const { source, destination, options } = args

    const configParam = toConfigParam({ ...(options.bisync || {}), ...(options.config || {}) })
    const filterParam = toFilterParam(options.filter)

    const { fullDirPath: srcFullDirPath, remoteName: srcRemoteName } = getFsInfo(source)
    const { fullDirPath: dstFullDirPath, remoteName: dstRemoteName } = getFsInfo(destination)

    return [
        {
            endpoint: '/sync/bisync',
            body: {
                path1: serializeOptions(srcFullDirPath, {
                    remote: remoteOptionsFor(options.remotes, srcRemoteName),
                }),
                path2: serializeOptions(dstFullDirPath, {
                    remote: remoteOptionsFor(options.remotes, dstRemoteName),
                }),
                ...(configParam ? { _config: configParam } : {}),
                ...(filterParam ? { _filter: filterParam } : {}),
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

export function buildDeleteRequests(args: DeleteArgs): RcRequest[] {
    const { sources, options } = args

    assertIncludeRules(sources, options.filter)
    assertFolderFilters(sources, options.filter)

    const configParam = toConfigParam(options.config || {})
    const filterParam = toFilterParam(options.filter)

    const inputs: BatchInput[] = []
    const handledSourcePaths: Record<string, true> = {}
    const folderSources = sources.filter((path) => path.endsWith('/') || path.endsWith('\\'))

    for (const source of sources) {
        if (handledSourcePaths[source]) {
            console.log('[buildDeleteRequests] skipping already handled source', source)
            continue
        }

        handledSourcePaths[source] = true

        const {
            root: srcRoot,
            filePath: srcFilePath,
            type: srcType,
            remoteName: srcRemoteName,
        } = getFsInfo(source)

        const srcOptions = remoteOptionsFor(options.remotes, srcRemoteName)

        if (srcType === 'folder') {
            inputs.push({
                _path: 'operations/delete',
                fs: serializeOptions(source, {
                    remote: srcOptions,
                }),
                ...(configParam ? { _config: configParam } : {}),
                ...(filterParam ? { _filter: filterParam } : {}),
            })
            continue
        }

        if (folderSources.some((folder) => source.startsWith(folder))) {
            console.log('[buildDeleteRequests] skipping child of handled folder', source)
            continue
        }

        inputs.push({
            _path: 'operations/deletefile',
            fs: serializeOptions(srcRoot, {
                remote: srcOptions,
            }),
            ...(configParam ? { _config: configParam } : {}),
            remote: srcFilePath,
        })
    }

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

export function buildPurgeRequests(args: PurgeArgs): RcRequest[] {
    const { sources, options } = args

    const configParam = toConfigParam(options.config || {})
    const inputs: BatchInput[] = []
    const handledSourcePaths: Record<string, true> = {}

    for (const source of sources) {
        if (handledSourcePaths[source]) {
            console.log('[buildPurgeRequests] skipping already handled source', source)
            continue
        }

        handledSourcePaths[source] = true

        const {
            root: srcRoot,
            filePath: srcDirPath,
            type: srcType,
            remoteName: srcRemoteName,
        } = getFsInfo(source)

        if (srcType !== 'folder') {
            throw new Error('Only folders can be purged')
        }

        inputs.push({
            _path: 'operations/purge',
            fs: serializeOptions(srcRoot, {
                remote: remoteOptionsFor(options.remotes, srcRemoteName),
            }),
            ...(configParam ? { _config: configParam } : {}),
            remote: srcDirPath,
        })
    }

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

/** Discriminated operation/args pair — ScheduledTask satisfies this. */
export type TaskRequestInput =
    | { operation: 'copy'; args: CopyArgs }
    | { operation: 'move'; args: MoveArgs }
    | { operation: 'sync'; args: SyncArgs }
    | { operation: 'bisync'; args: BisyncArgs }
    | { operation: 'delete'; args: DeleteArgs }
    | { operation: 'purge'; args: PurgeArgs }

/** Builds the RC requests for a scheduled task — throws when the args can't serialize. */
export function buildTaskRequests(task: TaskRequestInput): RcRequest[] {
    switch (task.operation) {
        case 'copy':
            return buildCopyRequests(task.args)
        case 'move':
            return buildMoveRequests(task.args)
        case 'sync':
            return buildSyncRequests(task.args)
        case 'bisync':
            return buildBisyncRequests(task.args)
        case 'delete':
            return buildDeleteRequests(task.args)
        case 'purge':
            return buildPurgeRequests(task.args)
        default:
            throw new Error(`Unknown operation: ${(task as { operation: string }).operation}`)
    }
}
