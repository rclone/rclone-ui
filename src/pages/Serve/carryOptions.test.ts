import { expect, test } from 'vitest'
import { carryOptions } from './carryOptions'

const options = (...names: string[]) => names.map((name) => ({ name }))

test('a serve type keeps the options it has too, with their values', () => {
    const http = { addr: ':8080', user: 'me', pass: 'secret', template: '/t.html', read_only: true }
    const ftp = options('addr', 'user', 'pass', 'passive_port', 'read_only')
    expect(carryOptions(http, ftp)).toEqual({
        addr: ':8080',
        user: 'me',
        pass: 'secret',
        read_only: true,
    })
})

test('options with no value are not carried', () => {
    const set = { addr: '', user: null, read_only: false, dir_cache_time: 0 }
    expect(carryOptions(set, options('addr', 'user', 'read_only', 'dir_cache_time'))).toEqual({
        read_only: false,
        dir_cache_time: 0,
    })
})

test('a type with none of them starts empty', () => {
    expect(carryOptions({ template: '/t.html' }, options('addr'))).toEqual({})
    expect(carryOptions({}, options('addr'))).toEqual({})
})
