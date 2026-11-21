import { describe, expect, it } from 'vitest'
import { POSIX, WINDOWS } from '../../../lib/paths'
import { startPathsProblem } from './useOperationSubmission'

describe('startPathsProblem', () => {
    it('is nothing for paths that can be sent, or none', () => {
        expect(
            startPathsProblem(
                { sources: ['gdrive:Photos', '/Users/me/x'], destination: 's3:b' },
                POSIX
            )
        ).toBeUndefined()
        expect(
            startPathsProblem({ source: 'gdrive:', destination: '/mnt/g' }, POSIX)
        ).toBeUndefined()
        expect(startPathsProblem({ destination: 'C:\\Downloads' }, WINDOWS)).toBeUndefined()
        // A missing path is reported by the page itself, not by this check.
        expect(startPathsProblem({ sources: [''], source: undefined }, POSIX)).toBeUndefined()
        expect(startPathsProblem({}, POSIX)).toBeUndefined()
    })

    it('names a source that would be read as something else', () => {
        expect(startPathsProblem({ sources: ['gdrive:x', 'Photos'] }, POSIX)).toBe(
            'Fix the source path'
        )
        expect(startPathsProblem({ source: '~/Photos', destination: 'Photos' }, POSIX)).toBe(
            'Fix the source path'
        )
        expect(startPathsProblem({ source: 'C:\\Photos' }, POSIX)).toBe('Fix the source path')
    })

    it('names a destination that would', () => {
        expect(startPathsProblem({ source: 'gdrive:', destination: 'mnt/gdrive' }, POSIX)).toBe(
            'Fix the destination path'
        )
        expect(startPathsProblem({ destination: 'M:' }, WINDOWS)).toBe('Fix the destination path')
        // A path that rclone would refuse.
        expect(startPathsProblem({ destination: '-gdrive:x' }, POSIX)).toBe(
            'Fix the destination path'
        )
    })
})
