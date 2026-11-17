import type { CopyVerifyPlan, TransferUnit } from '../../types/copyVerify'
import { getFsInfo } from '../format'
import {
    type BatchInput,
    type CopyArgs,
    buildCopyInputs,
    serializeOptions,
    toConfigParam,
    toFilterParam,
} from '../rclone/requests'

const RE_TRAILING_SLASHES = /\/+$/
const RE_LOCAL_WINDOWS_PATH = /^:local:[A-Za-z]:\//

function sourceIsFolder(source: string): boolean {
    return source.endsWith('/') || source.endsWith('\\')
}

function normalizePathForComparison(path: string): string {
    const normalized = path.replace(/\\/g, '/')
    if (normalized.length <= 1) return normalized
    const withoutTrailingSlash = normalized.replace(RE_TRAILING_SLASHES, '')
    return RE_LOCAL_WINDOWS_PATH.test(withoutTrailingSlash)
        ? withoutTrailingSlash.toLowerCase()
        : withoutTrailingSlash
}

function escapeFilterLiteral(value: string): string {
    // rclone filter rules use glob metacharacters. Escaping each one keeps a filename such as
    // `report[1]*?.txt` literal while the leading slash anchors it at the selected parent root.
    return value.replace(/[\\*?\[\]]/g, (character) => `\\${character}`)
}

function parentFs(root: string, filePath: string): string {
    const separator = filePath.lastIndexOf('/')
    if (separator < 0) return root
    return `${root}${filePath.slice(0, separator + 1)}`
}

function destinationObjectPath(destination: string, sourceName: string): string {
    const destinationInfo = getFsInfo(destination)
    return `${destinationInfo.fullDirPath}${sourceName}`
}

function destinationRemoteOptions(args: CopyArgs, path: string) {
    const remoteName = getFsInfo(path).remoteName
    return args.options.remotes?.[remoteName]
}

function verificationConfig(args: CopyArgs): string | undefined {
    return toConfigParam({
        ...(args.options.copy || {}),
        ...(args.options.config || {}),
        // Verification is always a real content comparison when the backend exposes a hash.
        size_only: false,
        ignore_checksum: false,
        dry_run: false,
    })
}

function buildVerificationInput(
    args: CopyArgs,
    source: string,
    copyInput: BatchInput,
    configParam: string | undefined
): BatchInput {
    const sourceInfo = getFsInfo(source)
    const destinationInfo = getFsInfo(args.destination)
    const sourceOptions = destinationRemoteOptions(args, source)
    const destinationOptions = destinationRemoteOptions(args, args.destination)

    const common = {
        oneWay: true,
        missingOnDst: true,
        differ: true,
        error: true,
        match: false,
        ...(configParam ? { _config: configParam } : {}),
    }

    if (sourceInfo.type === 'folder') {
        return {
            _path: 'operations/check',
            srcFs: copyInput.srcFs,
            dstFs: copyInput.dstFs,
            ...common,
            ...(copyInput._filter ? { _filter: copyInput._filter } : {}),
        }
    }

    const sourceParent = parentFs(sourceInfo.root, sourceInfo.filePath)
    const destinationParent = `${destinationInfo.root}${destinationInfo.dirPath}`
    const filenameRule = `/${escapeFilterLiteral(sourceInfo.name)}`

    return {
        _path: 'operations/check',
        srcFs: serializeOptions(sourceParent, { remote: sourceOptions }),
        dstFs: serializeOptions(destinationParent, { remote: destinationOptions }),
        ...common,
        // File copy inputs are intentionally not filterable in the legacy request builder. The
        // verification request is rooted at each parent and uses one exact filename rule instead.
        _filter: toFilterParam({ include: [filenameRule] }),
    }
}

function effectiveSources(args: CopyArgs): string[] {
    const handled = new Set<string>()
    const folders = args.sources.filter(sourceIsFolder)
    const sources: string[] = []

    for (const source of args.sources) {
        if (handled.has(source)) continue
        handled.add(source)
        if (folders.some((folder) => source.startsWith(folder)) && !sourceIsFolder(source)) {
            continue
        }
        sources.push(source)
    }

    return sources
}

export function buildCopyVerifyPlan(args: CopyArgs): CopyVerifyPlan {
    const copyInputs = buildCopyInputs(args)
    const sources = effectiveSources(args)

    if (copyInputs.length !== sources.length) {
        throw new Error('Unable to map effective Copy inputs to verification units')
    }

    const configParam = verificationConfig(args)
    const units: TransferUnit[] = sources.map((source, index) => {
        const copyInput = copyInputs[index]
        const sourceInfo = getFsInfo(source)
        return {
            id: `unit-${index + 1}`,
            kind: sourceInfo.type === 'folder' ? 'folder' : 'file',
            sourceDisplayPath: source,
            destinationDisplayPath: destinationObjectPath(args.destination, sourceInfo.name),
            copyInput,
            verificationInput: buildVerificationInput(args, source, copyInput, configParam),
        }
    })

    const destinations = new Map<string, TransferUnit>()
    for (const unit of units) {
        const key = normalizePathForComparison(unit.destinationDisplayPath)
        const existing = destinations.get(key)
        if (existing) {
            throw new Error(
                `Copy + Verify destination collision: ${unit.destinationDisplayPath} is targeted by ${existing.sourceDisplayPath} and ${unit.sourceDisplayPath}`
            )
        }
        destinations.set(key, unit)
    }

    return {
        units,
        copyInputs,
        verificationInputs: units.map((unit) => unit.verificationInput),
    }
}

export { escapeFilterLiteral }
