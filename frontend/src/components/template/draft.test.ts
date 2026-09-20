import { expect, test } from 'vitest'
import { SERVE_TYPES } from '../../../lib/rclone/constants'
import {
    MULTI_SOURCE_OPERATIONS,
    applyTemplatePaths,
    extraSourcesNote,
} from '../../../lib/rclone/templatePaths'
import {
    EMPTY_DRAFT,
    draftFromOptions,
    optionsFromCommand,
    optionsFromDraft,
    serveFlagsForTemplates,
} from './draft'

// src/components/template/draft.ts is pure, so it runs in the test process itself. It is the
// one place both template drawers turn a flat template into the eight option groups and back,
// and where the Add drawer turns a pasted command line into a template.

// A flag index in rclone's `/options/info` shape, one flag per block that matters here.
const FLAGS = {
    main: [
        { Name: 'transfers', Type: 'int', Groups: 'Copy,Performance' },
        { Name: 'track_renames', Type: 'bool', Groups: 'Sync' },
        { Name: 'metadata_set', Type: 'stringArray', Groups: 'Metadata' },
        { Name: 'checkers', Type: 'int', Groups: 'Performance' },
        { Name: 'log_level', Type: 'LogLevel', Groups: 'Logging' },
        { Name: 'tpslimit', Type: 'float64', Groups: 'Networking' },
    ],
    vfs: [{ Name: 'vfs_cache_mode', Type: 'CacheMode' }],
    filter: [{ Name: 'exclude', Type: 'stringArray' }],
    mount: [{ Name: 'allow_other', Type: 'bool' }],
    ...Object.fromEntries(
        SERVE_TYPES.map((type) => [type, [] as { Name: string; Type?: string }[]])
    ),
    http: [{ Name: 'addr', Type: 'string' }],
    webdav: [
        { Name: 'addr', Type: 'string' },
        { Name: 'etag_hash', Type: 'string' },
    ],
}

test('a command line becomes typed options, and one without flags becomes none', () => {
    const command =
        'rclone sync src: dst: --transfers=8 --track-renames --tpslimit 4 --exclude "*.tmp" --exclude=*.bak --addr :8080 --log-level=DEBUG --vfs-cache-mode full'
    expect(optionsFromCommand(command, FLAGS)).toEqual({
        transfers: 8,
        track_renames: true,
        exclude: ['*.tmp', '*.bak'],
        addr: ':8080',
        vfs_cache_mode: 'full',
    })
    // `--tpslimit` and `--log-level` are rclone's process, not a transfer's: not imported.
    // Without `--` there is nothing to import; the last character is not a flag.
    expect(optionsFromCommand('rclone copy a b', FLAGS)).toEqual({})
})

test('a template splits into the eight groups and joins back, serve protocols folded', () => {
    const options = {
        transfers: 4,
        track_renames: true,
        checkers: 16,
        vfs_cache_mode: 'writes',
        exclude: ['*.tmp'],
        allow_other: true,
        metadata_set: ['a=b'],
        addr: ':8080',
        etag_hash: 'md5',
    }
    const draft = draftFromOptions(options, FLAGS)
    expect(JSON.parse(draft.copy)).toEqual({ transfers: 4 })
    expect(JSON.parse(draft.sync)).toEqual({ track_renames: true })
    expect(JSON.parse(draft.config)).toEqual({ checkers: 16 })
    expect(JSON.parse(draft.vfs)).toEqual({ vfs_cache_mode: 'writes' })
    expect(JSON.parse(draft.filter)).toEqual({ exclude: ['*.tmp'] })
    expect(JSON.parse(draft.mount)).toEqual({ allow_other: true })
    expect(JSON.parse(draft.metadata)).toEqual({ metadata_set: ['a=b'] })
    // `addr` lives in http and webdav alike; the Serve tab shows the protocols as one document.
    expect(JSON.parse(draft.serve)).toEqual({ addr: ':8080', etag_hash: 'md5' })
    expect(optionsFromDraft(draft)).toEqual(options)
    // A flag the index does not know is dropped by the split, and so is one rclone would not
    // apply to the transfer.
    expect(optionsFromDraft(draftFromOptions({ unknown: 1 }, FLAGS))).toEqual({})
    expect(
        optionsFromDraft(draftFromOptions({ log_level: 'DEBUG', tpslimit: 4, checkers: 2 }, FLAGS))
    ).toEqual({ checkers: 2 })
    expect(optionsFromDraft(EMPTY_DRAFT)).toEqual({})
    expect(() => optionsFromDraft({ ...EMPTY_DRAFT, copy: '{' })).toThrow()
})

test('the serve tab lists every protocol flag once with their global defaults merged', () => {
    const { uniqueServeFlags, mergedGlobalServeFlags } = serveFlagsForTemplates(
        { http: [{ Name: 'addr' }], webdav: [{ Name: 'etag_hash' }, { Name: 'addr' }] } as any,
        { http: { addr: ':80' }, webdav: { etag_hash: 'md5' }, main: { transfers: 4 } }
    )
    expect(uniqueServeFlags.map((f) => f.Name)).toEqual(['addr', 'etag_hash'])
    expect(mergedGlobalServeFlags).toEqual({ addr: ':80', etag_hash: 'md5' })
})

// lib/rclone/templatePaths.ts is pure too: the one place that decides what "Add to Existing" and
// "Replace All" mean for a template's paths, for all eight operation pages.

test('a template applies its paths the way the dialog was answered', () => {
    const page = { sources: ['/tmp/one'], destination: 's3:old' }
    const template = { sources: ['~/Photos', '~/Videos'], destination: 'gdrive:backup' }

    // Replace: the template's paths win, field by field.
    expect(applyTemplatePaths(page, template, false)).toEqual(template)
    // Merge: its sources join the page's without repeating one, and a destination already
    // chosen is left alone.
    expect(applyTemplatePaths(page, template, true)).toEqual({
        sources: ['/tmp/one', '~/Photos', '~/Videos'],
        destination: 's3:old',
    })
    expect(applyTemplatePaths({ sources: ['~/Photos'] }, template, true).sources).toEqual([
        '~/Photos',
        '~/Videos',
    ])
    // ... and an empty destination is what merging is for.
    expect(applyTemplatePaths({ sources: [] }, template, true).destination).toBe('gdrive:backup')

    // A template carrying nothing never clears the page, whichever button was pressed.
    for (const empty of [undefined, {}, { sources: [] }]) {
        expect(applyTemplatePaths(page, empty, false)).toEqual(page)
        expect(applyTemplatePaths(page, empty, true)).toEqual(page)
    }
    // Half a template only replaces its half.
    expect(applyTemplatePaths(page, { destination: 'b2:new' }, false)).toEqual({
        sources: ['/tmp/one'],
        destination: 'b2:new',
    })
})

test('an operation that takes one source says which it will use', () => {
    expect(MULTI_SOURCE_OPERATIONS.has('copy')).toBe(true)
    expect(MULTI_SOURCE_OPERATIONS.has('sync')).toBe(false)
    expect(MULTI_SOURCE_OPERATIONS.has('delete')).toBe(true)

    const three = { sources: ['a', 'b', 'c'], destination: 'd' }
    expect(extraSourcesNote(three, 'sync')).toMatch(/3 sources/)
    expect(extraSourcesNote(three, 'copy')).toBeUndefined()
    expect(extraSourcesNote(three, 'delete')).toBeUndefined()
    expect(extraSourcesNote({ sources: ['a'] }, 'sync')).toBeUndefined()
    expect(extraSourcesNote(undefined, 'sync')).toBeUndefined()
})
