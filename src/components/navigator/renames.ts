// Works out what an ended batch rename did (`BatchRenameDrawer`). Its renames run as one
// transfer, one step per rename, in the order they were sent (the core's rename plan). A failed
// transfer records how each step went, and each of its failures (Retryable) gives the index of
// its step.

/**
 * The renames in `sent` that an ended batch completed: those that no failure points to. Only a
 * failed batch reports how each step went, so a stopped or interrupted batch returns none. A
 * failure without a step, or a failed batch with no failures, could involve any rename, so it
 * returns none as well.
 */
export function renamesDone<T>(
    state: string,
    sent: readonly T[],
    failures: readonly { step: number | null }[]
): T[] {
    if (state !== 'failed' || failures.length === 0) return []
    if (failures.some((failure) => failure.step === null)) return []
    const failed = new Set(failures.map((failure) => failure.step))
    return sent.filter((_, step) => !failed.has(step))
}
