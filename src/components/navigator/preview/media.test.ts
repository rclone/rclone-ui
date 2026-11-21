import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import { mediaQuery } from './media'

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

const HOUR = 60 * 60 * 1000

// A fake of the core's signer. Its URLs last `lifetime`, and `signed` counts them.
const signer = vi.hoisted(() => ({ lifetime: 0, signed: 0 }))

vi.mock('../../../../lib/core/api', () => ({
    media: {
        SignURL: async () => {
            signer.signed += 1
            return {
                url: `http://127.0.0.1:1/media?n=${signer.signed}`,
                expiresAt: Date.now() + signer.lifetime,
            }
        },
    },
}))

beforeEach(() => {
    signer.signed = 0
})

/** A query for a preview's signed URL, from a signer whose URLs last `lifetime`. */
function previewQuery(lifetime: number) {
    signer.lifetime = lifetime
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.mount()
    const observer = new QueryObserver(client, mediaQuery('gdrive:a.mp4', true))
    const off = observer.subscribe(() => undefined)
    return { client, observer, off }
}

// Missed events or a config change invalidate every query. A new URL would restart a playing
// video and reload a document.
test('asking every query again keeps a fresh signed URL', async () => {
    const { client, observer, off } = previewQuery(12 * HOUR)
    await tick()
    expect(signer.signed).toBe(1)
    await client.invalidateQueries()
    await tick()
    expect(signer.signed).toBe(1)
    expect(observer.getCurrentResult().data?.url).toBe('http://127.0.0.1:1/media?n=1')
    off()
})

test('a URL past half its life is signed again', async () => {
    const { client, off } = previewQuery(0)
    await tick()
    expect(signer.signed).toBe(1)
    await client.invalidateQueries()
    await tick()
    expect(signer.signed).toBe(2)
    off()
})
