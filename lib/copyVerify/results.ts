import type {
    CopyVerifyOperation,
    TransferUnit,
    VerificationIssue,
    VerificationMethod,
} from '../../types/copyVerify'

export interface BatchChildResult {
    error?: unknown
    success?: boolean
    input?: Record<string, unknown>
    output?: unknown
    [key: string]: unknown
}

export interface JobStatusLike {
    finished?: boolean
    success?: boolean
    error?: unknown
    output?: unknown
    duration?: number
    startTime?: string
    endTime?: string
}

export interface CopyAggregation {
    success: boolean
    errors: VerificationIssue[]
    message?: string
}

export interface VerificationAggregation {
    success: boolean
    method: VerificationMethod
    missingFiles: VerificationIssue[]
    differentFiles: VerificationIssue[]
    errors: VerificationIssue[]
    message?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.message
    try {
        return JSON.stringify(value) ?? String(value)
    } catch {
        return String(value)
    }
}

export function extractBatchResults(output: unknown): BatchChildResult[] | null {
    const record = asRecord(output)
    if (Array.isArray(record?.results)) {
        return record.results.map((result) => asRecord(result) ?? {})
    }
    if (Array.isArray(output)) {
        return output.map((result) => asRecord(result) ?? {})
    }
    return null
}

export function aggregateCopyResult(
    status: JobStatusLike,
    expectedInputCount: number,
    units: TransferUnit[]
): CopyAggregation {
    if (!status.finished) {
        return { success: false, errors: [], message: 'Copy job did not finish' }
    }

    if (status.error) {
        return { success: false, errors: [], message: stringValue(status.error) }
    }

    const results = extractBatchResults(status.output)
    if (!results || results.length !== expectedInputCount) {
        return {
            success: false,
            errors: [],
            message: `Copy returned ${results?.length ?? 0} results for ${expectedInputCount} submitted inputs`,
        }
    }

    const errors: VerificationIssue[] = []
    results.forEach((result, index) => {
        const error =
            result.error ??
            (result.success !== true ? 'Copy child did not report success' : undefined)
        if (error) {
            errors.push({
                unitId: units[index]?.id ?? `unit-${index + 1}`,
                path: String(result.input?.srcRemote ?? result.input?.dstRemote ?? 'unknown'),
                message: stringValue(error),
            })
        }
    })

    const parentFailed = status.success === false
    return {
        success: errors.length === 0 && !parentFailed,
        errors,
        ...(parentFailed && errors.length === 0 ? { message: 'Copy batch reported failure' } : {}),
    }
}

function unwrapCheckResult(result: BatchChildResult): Record<string, unknown> | null {
    const nested = asRecord(result.output)
    return nested ?? result
}

function issueList(value: unknown, unitId: string, fallbackMessage?: string): VerificationIssue[] {
    if (value === undefined || value === null || value === false) return []
    if (!Array.isArray(value)) {
        return [
            {
                unitId,
                path: 'error',
                message: fallbackMessage ?? stringValue(value),
            },
        ]
    }
    return value.map((entry) => {
        if (typeof entry === 'string') return { unitId, path: entry, message: fallbackMessage }
        const record = asRecord(entry)
        return {
            unitId,
            path: String(record?.path ?? record?.Path ?? record?.name ?? entry),
            ...(record?.message || fallbackMessage
                ? { message: String(record?.message ?? fallbackMessage) }
                : {}),
        }
    })
}

function classifyHashTypes(hashTypes: Array<string | undefined>): VerificationMethod {
    const normalized = hashTypes.map((hash) => hash?.trim().toLowerCase() ?? '')
    const unique = [...new Set(hashTypes.filter((hash): hash is string => !!hash?.trim()))]
    if (normalized.some((hash) => !hash || hash === 'unknown' || hash === 'unavailable')) {
        return { kind: 'unknown', hashTypes: unique }
    }
    const hasNone = normalized.some((hash) => hash === 'none')
    const realHashes = normalized.filter((hash) => hash !== 'none')
    if (realHashes.length === 0) return { kind: 'size_only', hashTypes: [] }
    if (hasNone) return { kind: 'mixed', hashTypes: unique }
    return { kind: 'checksum', hashTypes: unique }
}

export function classifyVerificationMethod(
    hashTypes: Array<string | undefined>
): VerificationMethod {
    return classifyHashTypes(hashTypes)
}

export function aggregateVerificationResult(
    status: JobStatusLike,
    units: TransferUnit[]
): VerificationAggregation {
    const emptyMethod = classifyHashTypes([])
    if (!status.finished) {
        return {
            success: false,
            method: emptyMethod,
            missingFiles: [],
            differentFiles: [],
            errors: [],
            message: 'Verification job did not finish',
        }
    }

    const results = extractBatchResults(status.output)
    if (!results || results.length !== units.length) {
        return {
            success: false,
            method: emptyMethod,
            missingFiles: [],
            differentFiles: [],
            errors: [],
            message: `Verification returned ${results?.length ?? 0} results for ${units.length} submitted inputs`,
        }
    }

    const missingFiles: VerificationIssue[] = []
    const differentFiles: VerificationIssue[] = []
    const errors: VerificationIssue[] = []
    const hashTypes: Array<string | undefined> = []

    results.forEach((result, index) => {
        const unitId = units[index]?.id ?? `unit-${index + 1}`
        const output = unwrapCheckResult(result)
        if (!output) {
            errors.push({ unitId, path: 'unknown', message: 'Missing structured check result' })
            return
        }

        hashTypes.push(typeof output.hashType === 'string' ? output.hashType : undefined)
        missingFiles.push(...issueList(output.missingOnDst, unitId))
        differentFiles.push(...issueList(output.differ, unitId))
        errors.push(...issueList(output.error, unitId))

        const hasUnitIssue =
            errors.some((issue) => issue.unitId === unitId) ||
            missingFiles.some((issue) => issue.unitId === unitId) ||
            differentFiles.some((issue) => issue.unitId === unitId)
        if (output.success !== true && !hasUnitIssue) {
            const message =
                typeof output.status === 'string' ? output.status : 'Verification failed'
            errors.push({ unitId, path: 'verification', message })
        }
    })

    if (status.error) {
        errors.push({
            unitId: 'operation',
            path: 'verification',
            message: stringValue(status.error),
        })
    }

    return {
        success: errors.length === 0 && missingFiles.length === 0 && differentFiles.length === 0,
        method: classifyHashTypes(hashTypes),
        missingFiles,
        differentFiles,
        errors,
    }
}

export function recoverFilesChecked(stats: unknown): number | null {
    const record = asRecord(stats)
    const checks = record?.checks
    return typeof checks === 'number' && Number.isFinite(checks) && checks >= 0 ? checks : null
}

export function operationHasRepairableIssues(operation: CopyVerifyOperation): boolean {
    return operation.missingFiles.length > 0 || operation.differentFiles.length > 0
}
