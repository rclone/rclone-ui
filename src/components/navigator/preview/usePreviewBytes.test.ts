import { expect, test } from 'vitest'
import { type ReadOf, readAtMost, readFor } from './usePreviewBytes'

/** A stream of chunks of the given sizes. Each chunk repeats the letter for its index. */
function streamOf(...sizes: number[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            sizes.forEach((size, i) => controller.enqueue(new Uint8Array(size).fill(97 + i)))
            controller.close()
        },
    })
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test('a longer stream is read up to the most, and said to go on', async () => {
    const seen: number[] = []
    const { bytes, done } = await readAtMost(streamOf(4, 4, 4).getReader(), 6, (n) => seen.push(n))
    expect(text(bytes)).toBe('aaaabb')
    expect(done).toBe(false)
    expect(seen).toEqual([4])
})

test('a shorter stream, or one exactly the most, is read whole', async () => {
    const shorter = await readAtMost(streamOf(2, 3).getReader(), 10)
    expect(text(shorter.bytes)).toBe('aabbb')
    expect(shorter.done).toBe(true)
    const exact = await readAtMost(streamOf(3, 3).getReader(), 6)
    expect(text(exact.bytes)).toBe('aaabbb')
    expect(exact.done).toBe(true)
    const unbounded = await readAtMost(streamOf(5).getReader(), Number.POSITIVE_INFINITY)
    expect(unbounded.bytes.byteLength).toBe(5)
    expect(unbounded.done).toBe(true)
})

// When switching files, the render for the next file comes before the read that fetches it. It
// must not present the previous file's bytes as the next file's.
test('a read held for another file is still loading for this one', () => {
    const read: ReadOf = {
        buffer: new ArrayBuffer(4),
        isLoading: false,
        error: null,
        progress: 1,
        truncated: false,
        url: 'http://core/media?p=a.pdf',
    }
    expect(readFor(read, 'http://core/media?p=a.pdf').buffer).toBe(read.buffer)
    const next = readFor(read, 'http://core/media?p=b.pdf')
    expect(next.buffer).toBeNull()
    expect(next.isLoading).toBe(true)
    // With no URL yet (it is still being signed), the state is loading, whatever was read before.
    expect(readFor(read, null)).toMatchObject({ buffer: null, isLoading: true, error: null })
})
