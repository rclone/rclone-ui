import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest'
import { coreFailure } from '../../../lib/errors.testing'
import { type JobArgs, JobRunner } from './jobs'

// A run that streams until it is closed. Each run records the signal it got and adds one item.
function streaming() {
    const signals: AbortSignal[] = []
    const run = (
        _args: JobArgs,
        _fresh: boolean,
        signal: AbortSignal,
        sink: { add(items: string[]): void }
    ) => {
        signals.push(signal)
        sink.add([`run ${signals.length}`])
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
    }
    return { run, signals }
}

test('asking again leaves a running listing to finish first', () => {
    const { run, signals } = streaming()
    const job = new JobRunner<string>(run)
    job.start({ path: 'gdrive:photos' })
    job.reask()
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(false)
    job.stop()
})

test('nothing asked is nothing to run again', () => {
    const { run, signals } = streaming()
    const job = new JobRunner<string>(run)
    job.reask()
    expect(signals).toHaveLength(0)
    expect(job.snapshot().phase).toBe('idle')
})

type Run = ConstructorParameters<typeof JobRunner<string>>[0]

// A run that the test feeds by hand through its sink. It runs until it is closed.
function fed() {
    const sinks: Parameters<Run>[3][] = []
    const run: Run = (_args, _fresh, signal, sink) => {
        sinks.push(sink)
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
    }
    return { run, sinks }
}

describe('a streamed listing', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('shows the first page at once and the pages after it together', () => {
        const { run, sinks } = fed()
        const job = new JobRunner<string>(run)
        const changes = vi.fn()
        job.subscribe(changes)
        job.start({ path: 'gdrive:photos' })
        changes.mockClear()

        sinks[0].add(['a', 'b'])
        expect(job.snapshot().items).toEqual(['a', 'b'])
        expect(changes).toHaveBeenCalledTimes(1)

        sinks[0].add(['c'])
        sinks[0].add(['d', 'e'])
        expect(job.snapshot().items).toEqual(['a', 'b'])

        vi.advanceTimersByTime(100)
        expect(job.snapshot()).toMatchObject({ items: ['a', 'b', 'c', 'd', 'e'], total: 5 })
        expect(changes).toHaveBeenCalledTimes(2)
        job.stop()
    })

    it('shows what is held with its end, in one change', () => {
        const { run, sinks } = fed()
        const job = new JobRunner<string>(run)
        job.start({ path: 'gdrive:photos' })
        sinks[0].add(['a'])
        sinks[0].add(['b'])
        const changes = vi.fn()
        job.subscribe(changes)

        sinks[0].end({ fetchedAt: 42 })
        expect(changes).toHaveBeenCalledTimes(1)
        expect(job.snapshot()).toMatchObject({ items: ['a', 'b'], phase: 'done', fetchedAt: 42 })

        // When the batch timer would have fired, there is nothing left to show.
        vi.advanceTimersByTime(100)
        expect(changes).toHaveBeenCalledTimes(1)
    })

    it('shows what is held with a failure, in one change', async () => {
        let fail: (error: Error) => void = () => undefined
        const sinks: Parameters<Run>[3][] = []
        const failing: Run = (_args, _fresh, _signal, sink) => {
            sinks.push(sink)
            return new Promise<void>((_resolve, reject) => {
                fail = reject
            })
        }
        const job = new JobRunner<string>(failing)
        job.start({ path: 'gdrive:photos' })
        sinks[0].add(['a'])
        sinks[0].add(['b'])
        const changes = vi.fn()
        job.subscribe(changes)

        fail(new Error('gone'))
        // The promise chain settles over a few microtasks, and the batch timer doesn't run.
        for (let i = 0; i < 10; i++) await Promise.resolve()
        expect(changes).toHaveBeenCalledTimes(1)
        expect(job.snapshot()).toMatchObject({
            items: ['a', 'b'],
            phase: 'failed',
            error: 'gone',
            notFound: false,
        })
    })

    it("marks a failure that the core reports as not_found, whatever rclone's text", async () => {
        const failing: Run = () => Promise.reject(coreFailure('not_found', 'object not found'))
        const job = new JobRunner<string>(failing)
        job.start({ path: 'gdrive:gone' })
        for (let i = 0; i < 10; i++) await Promise.resolve()
        expect(job.snapshot()).toMatchObject({ phase: 'failed', notFound: true })

        const other: Run = () => Promise.reject(coreFailure('failed', 'bucket does not exist'))
        const second = new JobRunner<string>(other)
        second.start({ path: 's3:bucket' })
        for (let i = 0; i < 10; i++) await Promise.resolve()
        expect(second.snapshot()).toMatchObject({ phase: 'failed', notFound: false })
    })

    it('stops at the cap and shows it at once', () => {
        const { run, sinks } = fed()
        const job = new JobRunner<string>(run, 3)
        job.start({ path: 'gdrive:photos' })
        sinks[0].add(['a'])
        sinks[0].add(['b', 'c', 'd'])
        expect(job.snapshot()).toMatchObject({
            items: ['a', 'b', 'c'],
            total: 3,
            phase: 'done',
            capped: true,
        })
    })

    it("never shows a closed job's held pages", () => {
        const { run, sinks } = fed()
        const job = new JobRunner<string>(run)
        job.start({ path: 'gdrive:photos' })
        sinks[0].add(['old 1'])
        sinks[0].add(['old 2'])

        job.start({ path: 'gdrive:music' })
        vi.advanceTimersByTime(100)
        expect(job.snapshot()).toMatchObject({ args: { path: 'gdrive:music' }, items: [] })

        sinks[1].add(['new'])
        expect(job.snapshot().items).toEqual(['new'])
        job.stop()
    })

    it('shows progress with the next batch', () => {
        const { run, sinks } = fed()
        const job = new JobRunner<string>(run)
        job.start({ paths: ['/a', '/b'] })
        sinks[0].add(['/a'])
        sinks[0].progress(1)
        sinks[0].add(['/b'])
        sinks[0].progress(2)
        expect(job.snapshot()).toMatchObject({ items: ['/a'], progress: undefined })

        vi.advanceTimersByTime(100)
        expect(job.snapshot()).toMatchObject({ items: ['/a', '/b'], progress: 2 })
        job.stop()
    })
})
