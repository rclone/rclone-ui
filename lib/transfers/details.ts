// Splits the finished files of a transfer for its page and for the Commander's bar. Pure.

export function splitFiles<F extends { error?: string }>(
    files: readonly F[] | null | undefined,
    /** Failures collected during the run, which last longer than the live window. */
    collected?: readonly F[]
) {
    const all = files ?? []
    return {
        transferred: all.filter((file) => !file.error),
        failed: collected ?? all.filter((file) => !!file.error),
    }
}
