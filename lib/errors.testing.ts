import type { CoreError } from './errors'

export function coreFailure(code: CoreError['code'], message: string, extra?: Partial<CoreError>) {
    return Object.assign(new Error(message), {
        name: 'RuntimeError',
        cause: { code, message, ...extra } satisfies CoreError,
    })
}
