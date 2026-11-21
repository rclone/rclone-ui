import { describe, expect, it } from 'vitest'
import { fallbackFilename, filenameProblem } from './downloadFilename'

describe('fallbackFilename', () => {
    it('is the last segment of the path, without the query', () => {
        expect(fallbackFilename('https://second.example/archive.zip?x=1#top')).toBe('archive.zip')
        expect(fallbackFilename('https://www.tiktok.com/@a/video/1')).toBe('1')
        expect(fallbackFilename('https://x.example/my%20clip.mp4')).toBe('my clip.mp4')
    })

    it('keeps a segment that decodes to no filename as it is', () => {
        expect(fallbackFilename('https://x.example/a%2Fb.mp4')).toBe('a%2Fb.mp4')
        expect(fallbackFilename('https://x.example/%E0%A4%A')).toBe('%E0%A4%A')
    })

    it('is the host’s name when the path ends in /', () => {
        for (const url of ['https://files.example.com/dir/', 'https://files.example.com']) {
            const name = fallbackFilename(url)
            expect(name.startsWith('files.example ')).toBe(true)
            expect(name.endsWith('.txt')).toBe(true)
            expect(filenameProblem(name)).toBe('')
        }
    })
})

describe('filenameProblem', () => {
    it('refuses what the core refuses', () => {
        for (const name of ['a/b.mp4', 'a\\b', '.', '..']) {
            expect(filenameProblem(name)).toBe('A filename cannot contain / or \\')
        }
        expect(filenameProblem('  ')).toBe('Please enter a filename')
        for (const name of ['clip.mp4', '..clip', 'a b']) {
            expect(filenameProblem(name)).toBe('')
        }
    })
})
