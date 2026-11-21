import { afterEach, expect, test, vi } from 'vitest'
import { isTransient, refusedFields, reportError, UserCancelledError } from './errors'
import { coreFailure } from './errors.testing'
import { message } from './shell'

vi.mock('./shell', () => ({ message: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

test('reportError always logs the error, then shows it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('boom')

    await reportError(error, { title: 'Could not save' })
    expect(log).toHaveBeenLastCalledWith('Could not save', error)
    expect(message).toHaveBeenLastCalledWith('boom', { title: 'Could not save', kind: 'error' })

    await reportError(error, { title: 'Could not save', log: ['[save] failed'] })
    expect(log).toHaveBeenLastCalledWith('[save] failed', error)
})

test('only an error a second try may change is transient', () => {
    expect(isTransient(coreFailure('unavailable', 'core away'))).toBe(true)
    expect(isTransient(coreFailure('failed', 'rclone failed'))).toBe(true)
    expect(isTransient(new Error('the page threw'))).toBe(true)

    expect(isTransient(coreFailure('not_found', 'no such file'))).toBe(false)
    expect(isTransient(coreFailure('invalid', 'bad path'))).toBe(false)
    expect(isTransient(coreFailure('internal', 'disk full'))).toBe(false)
    expect(isTransient(coreFailure('canceled', 'aborted'))).toBe(false)
    expect(isTransient(new UserCancelledError('dismissed'))).toBe(false)
})

test('a call that out-of-date bindings make is not transient', () => {
    // Wails rejects an unknown method with a ReferenceError and wrong arguments with a TypeError.
    expect(isTransient(new ReferenceError('unknown bound method id 2967362606'))).toBe(false)
    expect(isTransient(new TypeError('the method takes 3 arguments, got 2'))).toBe(false)
    expect(isTransient(new TypeError('Failed to fetch'))).toBe(true)
})

test("a refusal's fields are read by field, the first reason of each", () => {
    const refused = coreFailure('invalid', 'Taken.', {
        fields: [
            { field: 'url', description: 'Taken.' },
            { field: 'url', description: 'Second.' },
            { field: 'name', description: 'Missing.' },
        ],
    })
    expect(refusedFields(refused)).toEqual({ url: 'Taken.', name: 'Missing.' })
    expect(refusedFields(coreFailure('unavailable', 'the core stopped'))).toEqual({})
    expect(refusedFields(new Error('x'))).toEqual({})
})
