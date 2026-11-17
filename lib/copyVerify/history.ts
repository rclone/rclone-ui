import type { CopyVerifyOperation } from '../../types/copyVerify'

export const COPY_VERIFY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export function pruneTerminalOperations(
    operations: CopyVerifyOperation[],
    now: number
): CopyVerifyOperation[] {
    return operations.filter((operation) => {
        if (!['complete', 'verification_required'].includes(operation.phase)) return true
        const completedAt = Date.parse(operation.completedAt ?? operation.updatedAt)
        return !Number.isFinite(completedAt) || now - completedAt < COPY_VERIFY_RETENTION_MS
    })
}
