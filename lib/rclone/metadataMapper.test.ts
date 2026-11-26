import { expect, test } from 'vitest'
import {
    buildMapperValue,
    gatedDestinations,
    type MapperRule,
    parseMapperValue,
    quoteArgv,
} from './metadataMapper'

const EXE = '/opt/rclone cloud/rclone-cloud'

test('rules survive a trip through the flag and back', () => {
    const rules: MapperRule[] = [
        { kind: 'map', from: 'mtime', to: 'modified' },
        { kind: 'set', key: 'note', value: 'a=b=c' },
        { kind: 'drop', key: 'btime' },
    ]
    const value = buildMapperValue(rules, false)
    expect(value).toEqual([
        'metadata-map',
        '--only-mapped',
        '--map',
        'mtime=modified',
        '--set',
        'note=a=b=c',
        '--drop',
        'btime',
    ])
    expect(parseMapperValue(value)).toEqual({ rules, keepUnmapped: false })
})

test('an empty flag is ours to fill in', () => {
    for (const empty of ['', [], null, undefined as never]) {
        expect(parseMapperValue(empty)).toEqual({ rules: [], keepUnmapped: true })
    }
})

test('a program that is not ours is left alone', () => {
    expect(parseMapperValue(['/opt/bin/my-mapper', '--verbose'])).toBeNull()
    expect(parseMapperValue(['metadata-map', '--invent', 'x'])).toBeNull()
    expect(parseMapperValue([EXE, 'metadata-map', '--invent', 'x'])).toBeNull()
    expect(parseMapperValue([EXE, 'metadata-map', '--map', 'no-equals-sign'])).toBeNull()
    expect(parseMapperValue('metadata-map --map a=b')).toBeNull()
})

test('the command line shown to the user quotes what a shell would', () => {
    expect(quoteArgv([EXE, 'metadata-map', '--map', 'a=b'])).toBe(`"${EXE}" metadata-map --map a=b`)
})

test('a field the destination remote will not write is spotted before the copy runs', () => {
    const backendOptions = [
        { name: 'metadata_owner', defaultText: 'read' },
        { name: 'metadata_permissions', defaultText: 'off' },
    ]
    const gate = (
        fields: string[],
        config?: Record<string, unknown>,
        overrides?: Record<string, unknown>
    ) => gatedDestinations({ fields, backendOptions, config, overrides })

    expect(gate(['owner'])).toEqual([{ field: 'owner', option: 'metadata_owner', value: 'read' }])
    expect(gate(['permissions'])[0]).toMatchObject({ option: 'metadata_permissions', value: 'off' })

    expect(gate(['owner'], { metadata_owner: 'read,write' })).toEqual([])
    expect(gate(['owner'], { metadata_owner: 'read' }, { metadata_owner: 'write' })).toEqual([])
    expect(gate(['owner'], { metadata_owner: 'read,write' }, { metadata_owner: 'off' })).toEqual([
        { field: 'owner', option: 'metadata_owner', value: 'off' },
    ])

    expect(gate(['mtime', 'content-type'])).toEqual([])
    expect(gatedDestinations({ fields: ['owner'], backendOptions: undefined })).toEqual([])
})
