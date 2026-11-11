import { describe, expect, it } from 'vitest'
import type { HealthResult } from '../../../lib/remotes'
import { formatSize, summarize } from './usage'

const GB = 1024 ** 3

function ok(used: number, free: number, total: number): HealthResult {
    return { state: 'ok', about: { used, free, total } } as unknown as HealthResult
}

describe('formatSize', () => {
    it('writes a size in the largest unit that fits, with one decimal at most', () => {
        expect(formatSize(0)).toBe('0 B')
        expect(formatSize(640)).toBe('640 B')
        expect(formatSize(1536)).toBe('1.5 KB')
        expect(formatSize(2 * GB)).toBe('2 GB')
        expect(formatSize(640 * GB)).toBe('640 GB')
        expect(formatSize(1331 * GB)).toBe('1.3 TB')
        expect(formatSize(-1)).toBe('0 B')
    })
})

describe('summarize', () => {
    it('adds up remotes on different storage', () => {
        const s = summarize(['a', 'b'], {
            a: ok(10 * GB, 90 * GB, 100 * GB),
            b: ok(5 * GB, 5 * GB, 10 * GB),
        })
        expect(s.used).toBe(15 * GB)
        expect(s.free).toBe(95 * GB)
        expect(s.parts.map((p) => p.remote)).toEqual(['a', 'b'])
        expect(s.tones.a).not.toBe(s.tones.b)
    })

    it('counts storage that several remotes share once, in one part with one color', () => {
        const disk = ok(889 * GB, 37 * GB, 926 * GB)
        const s = summarize(['docs', 'photos', 'backup', 'cloud'], {
            docs: disk,
            photos: disk,
            backup: disk,
            cloud: ok(1 * GB, 14 * GB, 15 * GB),
        })
        expect(s.used).toBe(890 * GB)
        expect(s.free).toBe(51 * GB)
        expect(s.reporting).toBe(4)
        expect(s.parts).toHaveLength(2)
        expect(s.parts[0]).toMatchObject({ remote: 'backup, docs, photos', used: 889 * GB })
        expect(s.tones.docs).toBe(s.tones.backup)
        expect(s.tones.photos).toBe(s.tones.backup)
        expect(s.tones.cloud).not.toBe(s.tones.backup)
    })
})
