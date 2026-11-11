import type { CoreError } from './errors'

/** Builds a rejection like the one a bound call makes, carrying the core's error. For tests. */
export function coreFailure(code: CoreError['code'], message: string, extra?: Partial<CoreError>) {
    return Object.assign(new Error(message), {
        name: 'RuntimeError',
        cause: { code, message, ...extra } satisfies CoreError,
    })
}
