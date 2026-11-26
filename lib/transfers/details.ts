export function splitFiles<F extends { error?: string }>(
    files: readonly F[] | null | undefined,
    collected?: readonly F[]
) {
    const all = files ?? []
    return {
        transferred: all.filter((file) => !file.error),
        failed: collected ?? all.filter((file) => !!file.error),
    }
}
