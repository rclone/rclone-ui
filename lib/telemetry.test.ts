import { afterEach, describe, expect, it, vi } from 'vitest'
import { coreFailure } from './errors.testing'
import { reportPageError, track } from './telemetry'

const sent = vi.hoisted(() => ({
    errors: [] as unknown[][],
    events: [] as unknown[][],
}))

vi.mock('./core/api', () => ({
    telemetry: {
        PageError: async (...args: unknown[]) => {
            sent.errors.push(args)
        },
        Track: async (...args: unknown[]) => {
            sent.events.push(args)
        },
    },
}))

vi.mock('./shell', () => ({ windowName: () => 'Commander' }))

afterEach(() => {
    sent.errors.length = 0
    sent.events.length = 0
})

describe("a page's errors", () => {
    it('reports a crash with its kind, its message and its stack', () => {
        const error = new TypeError('x is not a function')
        reportPageError(error)
        expect(sent.errors).toEqual([
            ['Commander', 'TypeError', 'x is not a function', error.stack],
        ])
    })

    it('leaves out what is an answer rather than a crash', () => {
        // The core refused a form, or a remote needs a sign-in.
        reportPageError(coreFailure('invalid', 'Specify the folder to list.'))
        // A call that the page cancelled itself.
        reportPageError(Object.assign(new Error('cancelled'), { name: 'CancelError' }))
        reportPageError(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        // Something thrown that isn't an error has no stack to report.
        reportPageError('a string')
        reportPageError(undefined)
        expect(sent.errors).toEqual([])
    })
})

describe("a page's events", () => {
    it('go to the core by name, with flags and counts only', () => {
        track('disk_usage_opened', { local: true })
        track('batch_rename_opened', { items: 4 })
        expect(sent.events).toEqual([
            ['disk_usage_opened', { local: true }],
            ['batch_rename_opened', { items: 4 }],
        ])
    })
})
