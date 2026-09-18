import { expect, test } from '@playwright/test'
import {
    type MapperRule,
    buildMapperValue,
    gatedDestinations,
    metadataOptionsProblem,
    parseMapperValue,
    quoteArgv,
} from '../lib/rclone/metadataMapper'

// lib/rclone/metadataMapper.ts is pure, so it runs in the test process itself. It is the codec
// between the mapping drawer and the `metadata_mapper` flag: what it writes, rclone runs, and
// what it reads back is whatever the user (or an older version of the app) left in the JSON.

const EXE = '/Applications/Rclone UI.app/Contents/MacOS/Rclone UI'

test('rules survive a trip through the flag and back', () => {
    const rules: MapperRule[] = [
        { kind: 'map', from: 'mtime', to: 'modified' },
        { kind: 'set', key: 'note', value: 'a=b=c' },
        { kind: 'drop', key: 'btime' },
    ]
    const value = buildMapperValue(EXE, rules, false)
    // An argv array, never a string: the path above has a space in it.
    expect(value).toEqual([
        EXE,
        'metadata-map',
        '--only-mapped',
        '--map',
        'mtime=modified',
        '--set',
        'note=a=b=c',
        '--drop',
        'btime',
    ])
    expect(parseMapperValue(value)).toEqual({ exe: EXE, rules, keepUnmapped: false })
})

test('an empty flag is ours to fill in', () => {
    for (const empty of ['', [], null, undefined as never]) {
        expect(parseMapperValue(empty)).toEqual({ exe: '', rules: [], keepUnmapped: true })
    }
})

test('a program that is not ours is left alone', () => {
    expect(parseMapperValue(['/opt/bin/my-mapper', '--verbose'])).toBeNull()
    // Ours, but hand-edited into something this editor cannot show.
    expect(parseMapperValue([EXE, 'metadata-map', '--invent', 'x'])).toBeNull()
    expect(parseMapperValue([EXE, 'metadata-map', '--map', 'no-equals-sign'])).toBeNull()
})

test('a mapping written by an older install is adopted, path and all', () => {
    const parsed = parseMapperValue(['/old/path/rclone-ui-server', 'metadata-map', '--map', 'a=b'])
    expect(parsed).toEqual({
        exe: '/old/path/rclone-ui-server',
        rules: [{ kind: 'map', from: 'a', to: 'b' }],
        keepUnmapped: true,
    })
    // Saving again moves it to wherever this install lives.
    expect(buildMapperValue(EXE, parsed!.rules, parsed!.keepUnmapped)[0]).toBe(EXE)
})

test('the command line shown to the user quotes what a shell would', () => {
    expect(quoteArgv([EXE, 'metadata-map', '--map', 'a=b'])).toBe(`"${EXE}" metadata-map --map a=b`)
})

test('a mapper without metadata is not a usable set of options', () => {
    const mapper = buildMapperValue(EXE, [{ kind: 'map', from: 'a', to: 'b' }], true)
    // rclone does not call the mapper at all unless `metadata` is on, so the pair is the rule.
    expect(metadataOptionsProblem({ metadata_mapper: mapper })).toMatch(/metadata/)
    expect(metadataOptionsProblem({ metadata_mapper: mapper, metadata: false })).toMatch(/metadata/)
    expect(metadataOptionsProblem({ metadata_mapper: mapper, metadata: true })).toBeUndefined()

    // Nothing to run is nothing to complain about: the flag can sit there empty.
    expect(metadataOptionsProblem({})).toBeUndefined()
    expect(metadataOptionsProblem({ metadata_mapper: '' })).toBeUndefined()
    expect(metadataOptionsProblem({ metadata_mapper: [] })).toBeUndefined()
    expect(metadataOptionsProblem({ metadata: true })).toBeUndefined()
    // Somebody else's program is still a mapper.
    expect(metadataOptionsProblem({ metadata_mapper: ['/opt/bin/mapper'] })).toMatch(/metadata/)
})

test('a field the destination remote will not write is spotted before the copy runs', () => {
    // Google Drive as rclone ships it: `owner` is writable in principle, but the backend only
    // writes it when its own `metadata_owner` option says so — and that option defaults to
    // reading only, so a mapping into `owner` would be dropped without a word.
    const backendOptions = [
        { Name: 'metadata_owner', DefaultStr: 'read' },
        { Name: 'metadata_permissions', DefaultStr: 'off' },
    ]
    const gate = (
        fields: string[],
        config?: Record<string, unknown>,
        overrides?: Record<string, unknown>
    ) => gatedDestinations({ fields, backendOptions, config, overrides })

    expect(gate(['owner'])).toEqual([{ field: 'owner', option: 'metadata_owner', value: 'read' }])
    expect(gate(['permissions'])[0]).toMatchObject({ option: 'metadata_permissions', value: 'off' })

    // What the remote is actually configured with wins over the default, and a per-run override
    // in the Remotes section wins over both.
    expect(gate(['owner'], { metadata_owner: 'read,write' })).toEqual([])
    expect(gate(['owner'], { metadata_owner: 'read' }, { metadata_owner: 'write' })).toEqual([])
    expect(gate(['owner'], { metadata_owner: 'read,write' }, { metadata_owner: 'off' })).toEqual([
        { field: 'owner', option: 'metadata_owner', value: 'off' },
    ])

    // Ordinary fields have no such option, and an unknown backend gates nothing.
    expect(gate(['mtime', 'content-type'])).toEqual([])
    expect(gatedDestinations({ fields: ['owner'], backendOptions: undefined })).toEqual([])
})
