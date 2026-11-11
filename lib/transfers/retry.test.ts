import { expect, test } from 'vitest'
import { errorReason, rerunEffect } from './retry'

test('an error is shown by its reason, never as an empty line', () => {
    expect(
        errorReason(
            "couldn't copy from /data/photos/a.jpg to /backup/a.jpg.f39.partial: open /data/photos/a.jpg: permission denied"
        )
    ).toBe('permission denied')
    expect(
        errorReason(
            "googleapi: Error 403: The user's Drive storage quota has been exceeded., storageQuotaExceeded"
        )
    ).toBe("The user's Drive storage quota has been exceeded., storageQuotaExceeded")
    expect(errorReason('object not found')).toBe('object not found')
    expect(errorReason('failed: ')).toBe('failed:')
})

test('running it again says what happens to work already done', () => {
    expect(rerunEffect('move')).toContain('no longer at the source')
    expect(rerunEffect('purge')).toContain('already deleted')
    expect(rerunEffect('copy')).toBe('Files that already arrived are skipped.')
})
