import { expect, test } from '@playwright/test'
import { type OperationPreset, decodePreset, encodePreset, presetRoute } from '../lib/rclone/preset'

// lib/rclone/preset.ts is pure, so it runs in the test process itself. A preset is everything a
// page can open with (paths, every option group, remote overrides, the schedule, a template to
// keep), carried in the page's URL by the job drawer's Reuse settings and by the Wizard.

test('a preset round-trips through the URL parameter', () => {
    const preset: OperationPreset = {
        operation: 'copy',
        args: {
            sources: ['/tmp/e2e-src', 'gdrive:photos/2024'],
            destination: 'e2e-memory:copy',
            options: {
                copy: { ignore_existing: true },
                filter: { max_size: '10M', exclude: ['*.tmp'] },
                config: { transfers: 8 },
                remotes: { gdrive: { chunk_size: '64M' } },
            },
        },
        cron: '0 2 * * *',
        templateName: 'Nightly photos',
    }
    const encoded = encodePreset(preset)
    // Base64url: safe in a query string as it is.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodePreset(encoded, 'copy')).toEqual(preset)
    expect(presetRoute(preset)).toBe(`/copy?preset=${encoded}`)
})

test('a broken or foreign preset is ignored', () => {
    expect(decodePreset(undefined, 'copy')).toBeUndefined()
    expect(decodePreset('not base64!', 'copy')).toBeUndefined()
    expect(decodePreset(btoa('{"operation":"copy"'), 'copy')).toBeUndefined()
    expect(decodePreset(btoa('[1,2]'), 'copy')).toBeUndefined()
    expect(decodePreset(btoa('"copy"'), 'copy')).toBeUndefined()
    expect(decodePreset(btoa('{"operation":"copy","args":"x"}'), 'copy')).toBeUndefined()
    // The Move page must not take a Copy plan.
    const move = encodePreset({ operation: 'move', args: { sources: ['/tmp/a'] } })
    expect(decodePreset(move, 'copy')).toBeUndefined()
    expect(decodePreset(move, 'move')).toEqual({ operation: 'move', args: { sources: ['/tmp/a'] } })
})
