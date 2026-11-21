import { describe, expect, it } from 'vitest'
import { refusalOf } from './useFormRefusal'

/** A bound call's rejection, as Wails gives it, with the core's error as its cause. */
function rejection(cause: object): Error {
    const e = new Error('rejected', { cause })
    e.name = 'RuntimeError'
    return e
}

describe('refusalOf', () => {
    it("takes the core's refusal, with its field", () => {
        expect(
            refusalOf(
                rejection({
                    code: 'invalid',
                    message: 'Set "metadata": true to use the metadata mapper',
                    fields: [
                        {
                            field: 'options.metadata',
                            description: 'Set "metadata": true to use the metadata mapper',
                        },
                    ],
                })
            )
        ).toEqual({
            message: 'Set "metadata": true to use the metadata mapper',
            field: 'options.metadata',
        })
        expect(
            refusalOf(rejection({ code: 'invalid', message: 'gdrive: is the root of a remote.' }))
        ).toEqual({ message: 'gdrive: is the root of a remote.' })
    })

    it('ignores a failure that is not a refusal of the form', () => {
        expect(refusalOf(rejection({ code: 'unavailable', message: 'starting' }))).toBeNull()
        expect(refusalOf(new Error('plain'))).toBeNull()
    })
})
