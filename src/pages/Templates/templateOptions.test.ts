import { describe, expect, it } from 'vitest'
import { keptOf, seedTemplate, TEMPLATE_GROUPS, templateGroups } from './templateOptions'

// What the core's SortOptions returns for the options below. dry_run is a main option that a run
// can set, so it goes to config. bwlimit applies to the whole app, and nope is unknown, so both
// are skipped. Every serve type gets addr.
const sorted = {
    groups: {
        config: { transfers: 8, dry_run: true },
        copy: { ignore_existing: true },
        'serve.http': { addr: ':8080' },
        'serve.webdav': { addr: ':8080' },
    },
    skipped: [
        { flag: 'nope', reason: 'Rclone has no such flag.' },
        { flag: 'bwlimit', reason: 'Applies to the whole app, not to a single operation.' },
    ],
}
const options = {
    transfers: 8,
    '--dry-run': true,
    ignore_existing: true,
    nope: 1,
    bwlimit: '1M',
    addr: ':8080',
}

describe('templateGroups', () => {
    it('has every group, with the serves in one', () => {
        const groups = templateGroups({
            filter: { exclude: ['*.tmp'] },
            'serve.http': { addr: ':8080', template: 'x.html' },
            'serve.webdav': { addr: ':8080' },
        })
        expect(Object.keys(groups)).toEqual([...TEMPLATE_GROUPS])
        expect(groups.filter).toEqual({ exclude: ['*.tmp'] })
        expect(groups.serve).toEqual({ addr: ':8080', template: 'x.html' })
        expect(groups.mount).toEqual({})
    })
})

describe('seedTemplate', () => {
    it('fills the groups from the sorted groups and keeps what was skipped', () => {
        const { groups, rest } = seedTemplate(options, sorted)
        expect(groups.config).toEqual({ transfers: 8, dry_run: true })
        expect(groups.copy).toEqual({ ignore_existing: true })
        expect(groups.serve).toEqual({ addr: ':8080' })
        expect(groups.mount).toEqual({})
        expect(rest).toEqual({ nope: 1, bwlimit: '1M' })
    })

    it('reads missing groups as empty', () => {
        expect(seedTemplate({ x: 1 }, { groups: {}, skipped: [] })).toEqual({
            groups: Object.fromEntries(TEMPLATE_GROUPS.map((key) => [key, {}])),
            rest: {},
        })
    })
})

describe('the app defaults that a template leaves out', () => {
    // A page saved this template after the user removed the default transfers. The core sorts
    // the null into its group, like any option.
    const leftOut = { transfers: null, checkers: 4 }
    const sortedLeftOut = { groups: { config: { transfers: null, checkers: 4 } }, skipped: [] }

    it('keeps them through a load and a save', () => {
        const { groups, rest } = seedTemplate(leftOut, sortedLeftOut)
        expect(rest).toEqual({ transfers: null })
        const saved = { ...keptOf(rest, { checkers: 4 }), checkers: 4 }
        expect(saved).toEqual({ transfers: null, checkers: 4 })
        expect(groups.config).toEqual({ transfers: null, checkers: 4 })
    })

    it('drops one that a group sets again, under any spelling', () => {
        const { rest } = seedTemplate(leftOut, sortedLeftOut)
        expect(keptOf(rest, { transfers: 2 })).toEqual({})
        expect(keptOf(rest, { '--transfers': 2 })).toEqual({})
        expect(keptOf({ ...rest, nope: 1 }, { transfers: 2 })).toEqual({ nope: 1 })
    })
})
