import { expect, test } from '@playwright/test'
import { stopLeftoverJobs } from './helpers'

// What a test's page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
test.afterEach(({ request }) => stopLeftoverJobs(request))

// Pages must fit the Shell's content column.
for (const route of ['/commander', '/settings', '/copy', '/transfers']) {
    test(`no horizontal overflow on ${route}`, async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 })
        await page.goto(route)
        await page.waitForTimeout(1500)
        const metrics = await page.evaluate(() => {
            const outlet = document.querySelector('.browser-outlet') as HTMLElement
            const root = outlet.firstElementChild as HTMLElement
            return {
                outletWidth: outlet.clientWidth,
                rootWidth: root?.getBoundingClientRect().width ?? 0,
                scrollWidth: outlet.scrollWidth,
                viewport: window.innerWidth,
            }
        })
        expect(metrics.rootWidth).toBeLessThanOrEqual(metrics.outletWidth + 1)
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.outletWidth + 1)
        expect(metrics.outletWidth).toBeLessThan(metrics.viewport)
    })
}
