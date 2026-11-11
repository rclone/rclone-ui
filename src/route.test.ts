import { describe, expect, it } from 'vitest'
import { formOf } from '../lib/operations'
import { encodePreset } from '../lib/transfers/preset'
import { replaceQuestion, routeTitle, routeToFollow, startOf } from './route'

function at(route: string) {
    const url = new URL(route, 'wails://localhost')
    return { href: url.href, pathname: url.pathname }
}

describe('routeToFollow', () => {
    it('stays for a bare route to the page shown, whatever its query', () => {
        expect(routeToFollow('/remotes', at('/remotes?action=edit&remote=gdrive'))).toBeNull()
        expect(routeToFollow('/copy', at('/copy?preset=abc'))).toBeNull()
        expect(routeToFollow('/settings', at('/settings'))).toBeNull()
    })

    it('follows a route with a query', () => {
        expect(routeToFollow('/settings?tab=about', at('/settings'))).toBe('/settings?tab=about')
        // The same drawer requested again: the page remounts and shows it.
        expect(routeToFollow('/history?id=1', at('/history?id=1'))).toBe('/history?id=1')
    })

    it('follows a route to another page', () => {
        expect(routeToFollow('/copy', at('/settings'))).toBe('/copy')
    })
})

describe('replaceQuestion', () => {
    it('names the paths a route opens with', () => {
        expect(
            replaceQuestion('/sync?initialSource=gdrive%3APhotos&initialDestination=%2FUsers%2Fme')
        ).toBe('Replace what you entered with Sync from gdrive:Photos to /Users/me?')
        expect(replaceQuestion('/copy?initialSource=a&initialSource=b&initialSource=c')).toBe(
            'Replace what you entered with Copy from a and 2 more?'
        )
        expect(replaceQuestion('/move?initialDestination=s3%3Abucket')).toBe(
            'Replace what you entered with Move to s3:bucket?'
        )
        expect(replaceQuestion('/purge?initialSource=gdrive%3AOld')).toBe(
            'Replace what you entered with Purge of gdrive:Old?'
        )
        expect(replaceQuestion('/download?initialUrl=https%3A%2F%2Fexample.com%2Fa.zip')).toBe(
            'Replace what you entered with Download of https://example.com/a.zip?'
        )
    })

    it("names a preset's paths", () => {
        const preset = encodePreset(
            formOf('sync', { source: 'gdrive:Photos', destination: '/Users/me/Photos' })
        )
        expect(replaceQuestion(`/sync?preset=${preset}`)).toBe(
            'Replace what you entered with Sync from gdrive:Photos to /Users/me/Photos?'
        )
    })

    it('says a new form without paths', () => {
        expect(replaceQuestion('/mount?other=1')).toBe('Replace what you entered with a new Mount?')
        expect(replaceQuestion('/settings?tab=about')).toBe('Replace what you entered?')
    })
})

describe('routeTitle', () => {
    it("is the window's title", () => {
        expect(routeTitle('/bisync?initialSource=a')).toBe('Bisync')
        expect(routeTitle('/history?id=1')).toBe('History')
        expect(routeTitle('/wizard')).toBe('Run')
        expect(routeTitle('/startup')).toBe('Rclone UI')
    })
})

describe('startOf', () => {
    const query = (params: string) => new URLSearchParams(params)

    it("reads the query's paths", () => {
        expect(
            startOf(query('initialSource=a&initialSource=b&initialDestination=c&initialUrl=u'))
        ).toEqual({ sources: ['a', 'b'], destination: 'c', url: 'u' })
        expect(startOf(query(''))).toEqual({})
    })

    it("prefers the preset's paths to the query's", () => {
        const preset = formOf('sync', { source: 'gdrive:Photos', destination: '/Users/me' })
        const start = startOf(
            query(
                `preset=${encodePreset(preset)}&initialSource=x&initialDestination=y&initialUrl=u`
            ),
            'sync'
        )
        expect(start.preset).toEqual(preset)
        expect(start.sources).toEqual(['gdrive:Photos'])
        expect(start.destination).toBe('/Users/me')
        // The query fills in what the preset leaves out.
        expect(start.url).toBe('u')
    })

    it("keeps a preset's blank source, which the page asks to fill in", () => {
        const preset = formOf('sync', { source: '', destination: 'b' })
        expect(startOf(query(`preset=${encodePreset(preset)}`), 'sync').sources).toEqual([''])
    })

    it("leaves out a preset of another page's operation", () => {
        const preset = encodePreset(formOf('copy', { sources: ['a'], destination: 'b' }))
        expect(startOf(query(`preset=${preset}&initialSource=x`), 'sync')).toEqual({
            sources: ['x'],
        })
        expect(startOf(query(`preset=${preset}`)).sources).toEqual(['a'])
    })

    it("reads Download's link from its preset", () => {
        const preset = formOf('download', { url: 'https://example.com/a.zip', destination: 'd' })
        expect(startOf(query(`preset=${encodePreset(preset)}`), 'download')).toMatchObject({
            url: 'https://example.com/a.zip',
            destination: 'd',
        })
    })
})
