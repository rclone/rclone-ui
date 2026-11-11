import { QueryClient, QueryObserver, type QueryObserverResult } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { remotes as api } from './core/api'
import { coreKey } from './core/query'
import { coreFailure } from './errors.testing'
import { answered, type ConfigStep, namesOf, nextStep, type Remote, remoteValues } from './remotes'
import type { Option } from './shell/bindings/github.com/rclone/rclone-ui/core/catalog/models'

vi.mock('./core/api', () => ({ remotes: { Get: vi.fn(), CurrentSession: vi.fn() } }))
vi.mock('./live', () => ({ onLive: () => () => undefined }))

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

// Returns the data that RemoteEditDrawer seeds its form from. The data must have been fetched
// since the drawer opened, and must not be left over from before an error.
const seedable = (r: QueryObserverResult<Record<string, string>>) =>
    r.data && r.isFetchedAfterMount && !r.isError ? r.data : undefined

/**
 * Returns a query client and the Edit drawer's query for the `sftp` remote. The fake core returns
 * `answer()` as the host.
 */
function remoteQuery(answer: () => string) {
    vi.mocked(api.Get).mockImplementation((async () => {
        const host = answer()
        if (host === 'down') throw coreFailure('unavailable', 'the core is restarting')
        return { type: 'sftp', values: { host } }
    }) as unknown as typeof api.Get)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.mount()
    const options = {
        queryKey: coreKey('remotes', 'Get', { name: 'sftp' }),
        queryFn: () => api.Get('sftp'),
        select: remoteValues,
    }
    return { client, observe: () => new QueryObserver(client, options) }
}

/** Opens the drawer once, so its result is cached. */
async function openedBefore(observe: ReturnType<typeof remoteQuery>['observe']) {
    const off = observe().subscribe(() => undefined)
    await tick()
    off()
}

test('the edit form is seeded once, from the answer asked for on open', async () => {
    let host = 'old-host'
    const { client, observe } = remoteQuery(() => host)
    await openedBefore(observe)
    // The remote was saved with a new host since then.
    host = 'new-host'

    const opened = observe()
    const first = opened.getCurrentResult()
    const seeds: string[] = []
    opened.subscribe((r) => {
        const seed = seedable(r)
        if (seed && seeds.length === 0) seeds.push(seed.host)
    })
    await tick()
    for (let i = 0; i < 3; i++) {
        host = `host-${i}`
        await client.invalidateQueries()
        await tick()
    }
    // The cached result comes first, but it wasn't fetched after the drawer opened.
    expect(first.data?.host).toBe('old-host')
    expect(seedable(first)).toBeUndefined()
    expect(seeds).toEqual(['new-host'])
})

test('a failed fetch on open does not seed the form from the cached answer', async () => {
    let host = 'old-host'
    const { observe } = remoteQuery(() => host)
    await openedBefore(observe)
    host = 'down'

    const opened = observe()
    const results: QueryObserverResult<Record<string, string>>[] = []
    opened.subscribe((r) => results.push(r))
    await tick()
    const last = results.at(-1)
    expect(last?.isFetchedAfterMount).toBe(true)
    expect(last?.data?.host).toBe('old-host')
    expect(results.map(seedable).filter(Boolean)).toEqual([])
})

test('rclone asking the same question again after an answer is the next step', async () => {
    vi.useFakeTimers()
    try {
        const question: ConfigStep = {
            id: 'session',
            remote: 'drive',
            kind: 'reconnect',
            state: 'question',
            notice: 'The code was wrong.',
            authUrl: '',
            error: '',
            field: '',
            resultName: '',
            notRewritten: [],
            question: { name: 'config_code' } as Option,
            busy: '',
        }
        // After the answer, the core returns the same question again, word for word.
        vi.mocked(api.CurrentSession).mockImplementation((async () => ({
            ...question,
        })) as unknown as typeof api.CurrentSession)

        // Waiting from the question itself sees no change, so the drawer would hang.
        let settled = false
        nextStep(question).then(() => {
            settled = true
        })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(settled).toBe(false)

        await expect(nextStep(answered(question))).resolves.toEqual(question)
    } finally {
        vi.useRealTimers()
        vi.restoreAllMocks()
    }
})

test('namesOf sorts the names alphabetically, ignoring case', () => {
    const remotes = ['work', 'Backup', 'archive', '2024', 'dropbox'].map(
        (name) => ({ name, type: 'local' }) as Remote
    )
    expect(namesOf(remotes)).toEqual(['2024', 'archive', 'Backup', 'dropbox', 'work'])
})
