import { describe, expect, it } from 'vitest'
import { ROUTES, type RouteName, routeOf, WINDOWS } from './routes'

describe('ROUTES', () => {
    it('each load a page', async () => {
        for (const [name, def] of Object.entries(ROUTES)) {
            const page = await def.page()
            expect(typeof page.default, name).toBe('function')
        }
    })

    it('give a look to each window that the forms open', () => {
        for (const [name, def] of Object.entries(ROUTES)) {
            if ('form' in def) expect(WINDOWS[name as keyof typeof WINDOWS], name).toBe(def.look)
        }
    })
})

describe('routeOf', () => {
    it('finds a route by the first segment of its path', () => {
        const name = (url: string): RouteName | undefined => routeOf(url).name
        expect(name('/sync')).toBe('sync')
        expect(name('/schedules?id=1')).toBe('schedules')
        expect(name('/history/details?id=1')).toBe('history')
        expect(name('/guides/')).toBe('guides')
        expect(name('wails://localhost/copy?preset=abc')).toBe('copy')
        expect(routeOf('/wizard').def).toBe(ROUTES.wizard)
    })

    it('finds nothing for a path that no page has', () => {
        expect(routeOf('/')).toEqual({})
        expect(routeOf('/nowhere/sync')).toEqual({})
        expect(routeOf('/toString')).toEqual({})
    })
})

describe('WINDOWS', () => {
    it('holds the looks of the routes that have one', () => {
        expect(WINDOWS.wizard.title).toBe('Run')
        expect(Object.keys(WINDOWS)).not.toContain('startup')
        expect(Object.keys(WINDOWS)).not.toContain('launcher')
        for (const [name, look] of Object.entries(WINDOWS)) {
            expect(ROUTES[name as RouteName], name).toHaveProperty('look', look)
        }
    })
})
