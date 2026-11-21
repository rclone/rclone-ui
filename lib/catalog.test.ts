import { describe, expect, it } from 'vitest'
import { getJsonKeyCount, serveOptions } from './catalog'

describe('serveOptions', () => {
    it("merges every serve's options, and leaves out the other groups", () => {
        expect(
            serveOptions({
                config: { transfers: 4 },
                'serve.http': { addr: ':8080', template: 'x.html' },
                'serve.webdav': { addr: ':8080' },
            })
        ).toEqual({ addr: ':8080', template: 'x.html' })
    })
})

describe('getJsonKeyCount', () => {
    it("counts an object's keys, and nothing for text that isn't JSON", () => {
        expect(getJsonKeyCount('{"a":1,"b":2}')).toBe(2)
        expect(getJsonKeyCount('not json')).toBe(0)
    })
})
