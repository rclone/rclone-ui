import { describe, expect, it } from 'vitest'
import { difference, seedGroups } from './defaults'

const DEFAULTS = {
    copy: { multi_thread_streams: 8 },
    config: { transfers: 8, checkers: 16, fast_list: true },
}
const KEYS = ['copy', 'filter', 'config'] as const

describe('seedGroups', () => {
    it('starts each group with its defaults', () => {
        expect(seedGroups(KEYS, DEFAULTS, undefined)).toEqual({
            copy: { multi_thread_streams: 8 },
            filter: {},
            config: { transfers: 8, checkers: 16, fast_list: true },
        })
    })

    it('puts the preset over the defaults, and leaves out its nulls', () => {
        expect(
            seedGroups(KEYS, DEFAULTS, {
                filter: { exclude: ['*.tmp'] },
                config: { transfers: 4, checkers: null },
            })
        ).toEqual({
            copy: { multi_thread_streams: 8 },
            filter: { exclude: ['*.tmp'] },
            config: { transfers: 4, fast_list: true },
        })
    })

    it('leaves out a default that the preset names in another group or spelling', () => {
        expect(
            seedGroups(KEYS, DEFAULTS, { copy: { transfers: 2, '--fast-list': false } })
        ).toEqual({
            copy: { multi_thread_streams: 8, transfers: 2, '--fast-list': false },
            filter: {},
            config: { checkers: 16 },
        })
    })

    it('starts from the preset alone without defaults', () => {
        expect(seedGroups(['config'], undefined, { config: { transfers: 4 } })).toEqual({
            config: { transfers: 4 },
        })
    })
})

describe('difference', () => {
    it('sends nothing for the defaults as they are', () => {
        expect(difference(DEFAULTS, seedGroups(KEYS, DEFAULTS, undefined))).toEqual({
            copy: {},
            filter: {},
            config: {},
        })
    })

    it('sends a changed value, a new option, and null for a removed default', () => {
        expect(
            difference(DEFAULTS, {
                copy: { multi_thread_streams: 8 },
                filter: { exclude: ['*.tmp'] },
                config: { transfers: 4, fast_list: true },
            })
        ).toEqual({
            copy: {},
            filter: { exclude: ['*.tmp'] },
            config: { transfers: 4, checkers: null },
        })
    })

    it('sends a default moved to another group, without a null', () => {
        expect(
            difference(DEFAULTS, {
                copy: { multi_thread_streams: 8, checkers: 16 },
                filter: {},
                config: { transfers: 8, fast_list: true },
            })
        ).toEqual({ copy: { checkers: 16 }, filter: {}, config: {} })
    })

    it('compares values by their JSON', () => {
        expect(
            difference(
                { filter: { exclude: ['a', 'b'] }, config: { transfers: 8 } },
                { filter: { exclude: ['a', 'b'] }, config: { transfers: '8' } }
            )
        ).toEqual({ filter: {}, config: { transfers: '8' } })
    })

    it('round-trips through seedGroups', () => {
        const sent = difference(DEFAULTS, {
            copy: {},
            filter: {},
            config: { transfers: 4, checkers: 16 },
        })
        expect(sent).toEqual({
            copy: { multi_thread_streams: null },
            filter: {},
            config: { transfers: 4, fast_list: null },
        })
        expect(seedGroups(KEYS, DEFAULTS, sent)).toEqual({
            copy: {},
            filter: {},
            config: { transfers: 4, checkers: 16 },
        })
    })
})
