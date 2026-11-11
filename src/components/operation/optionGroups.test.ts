import { describe, expect, it } from 'vitest'
import type { Option } from '../../../lib/catalog'
import { CATEGORY_META } from './OptionsAccordion'
import { type Flags, type GroupKey, OPTION_GROUPS } from './optionGroups'

const option = (name: string) => ({ name }) as Option

// A catalog with two serve types. addr is in both, with a different app-wide value in each.
const flags = {
    globalFlags: {
        main: { transfers: '8' },
        filter: { exclude: ['*.tmp'] },
        mount: { allow_other: 'true' },
        http: { addr: ':8080' },
        webdav: { addr: ':9090', user: 'me' },
    },
    copyFlags: [option('checksum')],
    syncFlags: [option('delete_before')],
    filterFlags: [option('exclude')],
    configFlags: [option('transfers')],
    mountFlags: [option('allow_other')],
    vfsFlags: [option('vfs_cache_mode')],
    metadataFlags: [option('metadata')],
    serveTypes: ['http', 'webdav'],
    serveFlags: {
        http: [option('template'), option('addr')],
        webdav: [option('addr'), option('user')],
    },
} as unknown as Flags

describe('OPTION_GROUPS', () => {
    it('has a row look for every group', () => {
        for (const [key, group] of Object.entries(OPTION_GROUPS)) {
            expect(CATEGORY_META[group.category], key).toBeDefined()
        }
    })

    it("offers the catalog's list of each group", () => {
        const names = (key: GroupKey) => OPTION_GROUPS[key].available(flags).map((o) => o.name)
        expect(names('copy')).toEqual(['checksum'])
        // Move and bisync take copy's options.
        expect(names('move')).toEqual(['checksum'])
        expect(names('bisync')).toEqual(['checksum'])
        expect(names('sync')).toEqual(['delete_before'])
        expect(names('filter')).toEqual(['exclude'])
        expect(names('metadata')).toEqual(['metadata'])
    })

    it('starts the metadata options from the main and filter values', () => {
        expect(OPTION_GROUPS.metadata.global(flags)).toEqual({
            transfers: '8',
            exclude: ['*.tmp'],
        })
        expect(OPTION_GROUPS.config.global(flags)).toEqual({ transfers: '8' })
        expect(OPTION_GROUPS.mount.global(flags)).toEqual({ allow_other: 'true' })
    })

    it('offers the options of one serve type', () => {
        const serve = OPTION_GROUPS.serve
        expect(serve.available(flags, 'webdav').map((o) => o.name)).toEqual(['addr', 'user'])
        expect(serve.global(flags, 'http')).toEqual({ addr: ':8080' })
        expect(serve.available(flags, 'nfs')).toEqual([])
    })

    it('merges every serve type without one', () => {
        const serve = OPTION_GROUPS.serve
        expect(serve.available(flags).map((o) => o.name)).toEqual(['addr', 'template', 'user'])
        // A later type's value wins.
        expect(serve.global(flags)).toEqual({ addr: ':9090', user: 'me' })
    })

    it('reads a catalog that has not arrived as empty', () => {
        const none = { globalFlags: undefined, serveTypes: [], serveFlags: {} } as unknown as Flags
        for (const [key, group] of Object.entries(OPTION_GROUPS)) {
            expect(group.available(none), key).toEqual([])
            expect(group.global(none), key).toEqual({})
        }
    })
})
