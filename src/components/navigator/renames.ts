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
