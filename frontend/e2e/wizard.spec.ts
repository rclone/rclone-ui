import { expect, test } from '@playwright/test'
import {
    type Answers,
    metadataPhrase,
    presetFromAnswers,
    sentence,
    stepComplete,
    stepsFor,
} from '../src/pages/Wizard/flow'

// src/pages/Wizard/flow.ts is the Wizard's model and pure, so it runs in the test process itself:
// which questions a set of answers walks through, what they amount to, and how the plan reads.

const MAPPER = ['/opt/rclone cloud/rclone-cloud', 'metadata-map']
const ONE_RULE = [...MAPPER, '--map', 'mtime=modified']

const copy = (patch: Partial<Answers> = {}): Answers => ({
    goal: 'transfer',
    refine: 'copy',
    source: '/tmp/a',
    destination: '/tmp/b',
    ...patch,
})

test('metadata is asked about where it moves: copy, move, sync and bisync', () => {
    // After the places (the panel suggests each side's fields) and before the schedule.
    expect(stepsFor(copy())).toEqual([
        'goal',
        'refine',
        'places',
        'metadata',
        'when',
        'keep',
        'plan',
    ])
    for (const refine of ['move', 'sync', 'bisync'] as const) {
        const goal = refine === 'move' ? 'transfer' : 'match'
        expect(stepsFor({ goal, refine })).toContain('metadata')
    }
    // A mount, a share, a download and a clear-out carry nothing across.
    expect(stepsFor({ goal: 'mount' })).not.toContain('metadata')
    expect(stepsFor({ goal: 'share', refine: 'http' })).not.toContain('metadata')
    expect(stepsFor({ goal: 'download' })).not.toContain('metadata')
    expect(stepsFor({ goal: 'clear', refine: 'delete' })).not.toContain('metadata')
    expect(stepsFor({ goal: 'clear', refine: 'purge' })).not.toContain('metadata')
})

test('a mapping is an answer once it has a rule', () => {
    expect(stepComplete('metadata', copy())).toBe(false)
    expect(stepComplete('metadata', copy({ metadata: 'none' }))).toBe(true)
    expect(stepComplete('metadata', copy({ metadata: 'keep' }))).toBe(true)
    // "Yes, with changes" without a rule is "Yes": the step waits for one.
    expect(stepComplete('metadata', copy({ metadata: 'map' }))).toBe(false)
    expect(stepComplete('metadata', copy({ metadata: 'map', mapper: ONE_RULE }))).toBe(true)
})

test('the answer reaches the page as its Metadata options', () => {
    const options = (answers: Answers) => {
        const preset = presetFromAnswers(answers)
        return preset?.operation === 'copy' ? preset.args.options : undefined
    }
    expect(options(copy({ metadata: 'none' }))).toEqual({})
    // rclone carries metadata only with `metadata` on, and never runs a mapper without it.
    expect(options(copy({ metadata: 'keep' }))).toEqual({ metadata: { metadata: true } })
    expect(options(copy({ metadata: 'map', mapper: ONE_RULE }))).toEqual({
        metadata: { metadata: true, metadata_mapper: ONE_RULE },
    })
    const sync = presetFromAnswers({ ...copy({ metadata: 'keep' }), goal: 'match', refine: 'sync' })
    expect(sync?.operation === 'sync' && sync.args.options).toEqual({
        metadata: { metadata: true },
    })
})

test('the plan says whether metadata comes along', () => {
    const text = (answers: Answers) =>
        sentence(answers)
            .map((segment) => segment.text)
            .join('')
    expect(text(copy({ metadata: 'none', when: 'once' }))).toBe(
        'Copy the files in /tmp/a to /tmp/b, once.'
    )
    expect(text(copy({ metadata: 'keep', when: 'daily' }))).toBe(
        'Copy the files in /tmp/a to /tmp/b, metadata included, every day at 2:00.'
    )
    expect(text(copy({ metadata: 'map', mapper: ONE_RULE }))).toBe(
        'Copy the files in /tmp/a to /tmp/b, metadata mapped.'
    )
    // The plan's row: how many rules change it.
    expect(metadataPhrase(copy({ metadata: 'none' }))).toBe('No')
    expect(metadataPhrase(copy({ metadata: 'keep' }))).toBe('Yes')
    expect(metadataPhrase(copy({ metadata: 'map', mapper: ONE_RULE }))).toBe('Yes, with 1 rule')
    expect(
        metadataPhrase(copy({ metadata: 'map', mapper: [...ONE_RULE, '--drop', 'btime'] }))
    ).toBe('Yes, with 2 rules')
})
