import { describe, expect, it } from 'vitest'
import { missOf, sitesDescription } from './downloadSites'

describe('missOf', () => {
    it('misses nothing when the file was found', () => {
        expect(missOf({ found: true, miss: '', filename: 'a.mp4' })).toBeUndefined()
    })

    it("says that a site's page held no file", () => {
        expect(missOf({ found: false, miss: 'nothing', filename: '' })).toBe('nothing')
        // A file without a name can't be saved as one.
        expect(missOf({ found: true, miss: '', filename: '' })).toBe('nothing')
    })

    it("says that the service couldn't be reached", () => {
        expect(missOf({ found: false, miss: 'unreachable', filename: '' })).toBe('unreachable')
    })

    it("misses nothing for a file's own address, which is never looked up", () => {
        expect(missOf({ found: false, miss: '', filename: '' })).toBeUndefined()
    })
})

describe('sitesDescription', () => {
    it('names the first sites and counts the rest', () => {
        expect(
            sitesDescription([
                'Instagram',
                'TikTok',
                'Facebook',
                'X (Twitter)',
                'YouTube',
                'Spotify',
            ])
        ).toBe(
            'A link to a file or a page on Instagram, TikTok, Facebook, X (Twitter), and 2 more. Rclone UI detects the content behind it and downloads the video, audio or image.'
        )
    })

    it('names a few sites in full', () => {
        expect(sitesDescription(['YouTube', 'SoundCloud'])).toBe(
            'A link to a file or a page on YouTube and SoundCloud. Rclone UI detects the content behind it and downloads the video, audio or image.'
        )
        expect(sitesDescription(['YouTube'])).toBe(
            'A link to a file or a page on YouTube. Rclone UI detects the content behind it and downloads the video, audio or image.'
        )
    })

    it('says a file without sites', () => {
        expect(sitesDescription([])).toBe('A link to a file.')
    })
})
