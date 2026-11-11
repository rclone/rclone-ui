import { describe, expect, it } from 'vitest'
import type { Browse } from '../../../lib/core/types'
import { listedFolders, measured, sizesAsk } from './folderSizes'
import { type JobArgs, JobRunner } from './jobs'

const row = (path: string, isDir: boolean): Browse.Row => ({
    path,
    name: path.split('/').pop() ?? '',
    size: isDir ? 64 : 3,
    modTime: '',
    isDir,
    id: '',
    tier: '',
    isBucket: false,
})

const HOME = '/Users/me'
const ROWS = [
    row('/Users/me/docs', true),
    row('/Users/me/.cache', true),
    row('/Users/me/a.txt', false),
]
const DONE = { phase: 'done', items: ROWS, fetchedAt: 100 } as const
const ASK = { paths: ['/Users/me/docs'], fetchedAt: 100 }

describe('listedFolders', () => {
    it("names a finished local listing's visible folders by their path, with when it was listed", () => {
        expect(listedFolders(DONE, HOME)).toEqual({ ...ASK, folder: HOME })
    })

    it('names nothing before the listing is done, off a local folder, or with no folders', () => {
        expect(listedFolders({ ...DONE, phase: 'running' }, HOME)).toBeNull()
        expect(listedFolders({ ...DONE, fetchedAt: undefined }, HOME)).toBeNull()
        expect(listedFolders(DONE, null)).toBeNull()
        expect(listedFolders({ ...DONE, items: [row('/Users/me/a.txt', false)] }, HOME)).toBeNull()
    })
})

describe('sizesAsk (the file panels ask `sizes:<slot>`)', () => {
    const done = listedFolders(DONE, HOME)

    it('asks for the folders of a finished listing', () => {
        expect(sizesAsk(true, 'done', done, null, HOME)).toEqual(ASK)
    })

    it('keeps following the same folder while it is listed again, and no other', () => {
        expect(sizesAsk(true, 'running', null, done, HOME)).toEqual(ASK)
        expect(sizesAsk(true, 'running', null, done, '/Users')).toBeNull()
        expect(sizesAsk(true, 'running', null, done, null)).toBeNull()
        expect(sizesAsk(true, 'failed', null, done, HOME)).toBeNull()
    })

    it('asks nothing when folder sizes are off', () => {
        expect(sizesAsk(false, 'done', done, null, HOME)).toBeNull()
        expect(sizesAsk(false, 'running', null, done, HOME)).toBeNull()
    })

    it('turned off, cancels the running count at once; turned on, asks again', () => {
        const runs: { args: JobArgs; signal: AbortSignal }[] = []
        const job = new JobRunner(async (args, _fresh, signal) => {
            runs.push({ args, signal })
            await new Promise(() => undefined)
        })
        // Mimics what useJob does with the hook's arguments on each render.
        const render = (on: boolean) => job.start(sizesAsk(on, 'done', done, null, HOME))

        render(true)
        expect(runs).toHaveLength(1)
        expect(runs[0].args).toMatchObject({ paths: ['/Users/me/docs'], fetchedAt: 100 })

        render(false)
        expect(runs[0].signal.aborted).toBe(true)
        expect(job.snapshot().items).toEqual([])
        render(false)
        expect(runs).toHaveLength(1)

        render(true)
        expect(runs).toHaveLength(2)
    })
})

describe('measured', () => {
    it('keeps the folders measured to the end, by path', () => {
        const sizes = measured([
            { request: 'r', path: '/a', files: 1, bytes: 5 },
            { request: 'r', path: '/b', files: 9, bytes: 90, partial: true },
            { request: 'r', files: 0, bytes: 0, done: true },
        ])
        expect([...sizes]).toEqual([['/a', 5]])
    })
})
