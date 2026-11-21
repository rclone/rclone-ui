import { describe, expect, it } from 'vitest'
import { decodePreset } from '../../../lib/transfers/preset'
import { DEFAULT_WHEN } from '../../components/schedule/when'
import {
    type Answers,
    metadataPhrase,
    routeFor,
    sentence,
    stepComplete,
    stepsFor,
    templateFor,
    whenPhrase,
    withRefine,
} from './flow'

const ONE_RULE = ['metadata-mapper', '--map', 'mtime=modified']

const copy = (patch: Partial<Answers> = {}): Answers => ({
    goal: 'transfer',
    refine: 'copy',
    sources: ['/tmp/a'],
    destination: '/tmp/b',
    ...patch,
})

const text = (answers: Answers) =>
    sentence(answers)
        .map((segment) => segment.text)
        .join('')

const presetOf = (route: string | undefined) =>
    decodePreset(new URL(route ?? '', 'wails://localhost').searchParams.get('preset'))

describe('stepsFor', () => {
    it('asks about metadata where files travel, and when where a schedule can run it', () => {
        expect(stepsFor(copy())).toEqual([
            'goal',
            'refine',
            'places',
            'metadata',
            'when',
            'keep',
            'plan',
        ])
        expect(stepsFor({ goal: 'mount' })).toEqual(['goal', 'places', 'keep', 'plan'])
        expect(stepsFor({ goal: 'share', refine: 'webdav' })).toEqual([
            'goal',
            'refine',
            'places',
            'keep',
            'plan',
        ])
        // A download keeps no template either.
        expect(stepsFor({ goal: 'download' })).toEqual(['goal', 'places', 'plan'])
        expect(stepsFor({ goal: 'clear', refine: 'purge' })).toEqual([
            'goal',
            'refine',
            'places',
            'when',
            'keep',
            'plan',
        ])
    })
})

describe('withRefine', () => {
    // Nothing here tells a file from a folder, so a picker that takes folders only asks again.
    it('asks again for sources picked where files could be', () => {
        const toDelete: Answers = { goal: 'clear', refine: 'delete', sources: ['e2e:a.txt'] }
        expect(withRefine(toDelete, 'purge')).toEqual({ goal: 'clear', refine: 'purge' })
        const toPurge: Answers = { goal: 'clear', refine: 'purge', sources: ['e2e:photos'] }
        expect(withRefine(toPurge, 'delete')).toEqual({ ...toPurge, refine: 'delete' })
        expect(withRefine(copy(), 'move')).toEqual(copy({ refine: 'move' }))
    })
})

describe('stepComplete', () => {
    it('needs every place, and no place twice', () => {
        expect(stepComplete('places', copy())).toBe(true)
        expect(stepComplete('places', copy({ destination: ' ' }))).toBe(false)
        expect(stepComplete('places', copy({ destination: '/tmp/a' }))).toBe(false)
    })

    it('takes a mapping once it has a rule', () => {
        expect(stepComplete('metadata', copy({ metadata: 'keep' }))).toBe(true)
        expect(stepComplete('metadata', copy({ metadata: 'map' }))).toBe(false)
        expect(stepComplete('metadata', copy({ metadata: 'map', mapper: ONE_RULE }))).toBe(true)
    })

    it('takes a schedule whose time the core accepts', () => {
        const scheduled = copy({ when: 'schedule', schedule: DEFAULT_WHEN })
        expect(stepComplete('when', copy({ when: 'once' }))).toBe(true)
        expect(stepComplete('when', scheduled)).toBe(true)
        expect(stepComplete('when', scheduled, 'Not a time.')).toBe(false)
        const empty = copy({ when: 'schedule', schedule: { ...DEFAULT_WHEN, kind: 'custom' } })
        expect(stepComplete('when', empty)).toBe(false)
    })

    it('needs a name for a template', () => {
        expect(stepComplete('keep', copy({ keep: 'template', templateName: ' ' }))).toBe(false)
        expect(stepComplete('keep', copy({ keep: 'template', templateName: 'Nightly' }))).toBe(true)
    })
})

describe('sentence', () => {
    it('fills in as the answers come', () => {
        expect(text({ goal: 'transfer' })).toBe('Copy or move the files in somewhere to somewhere.')
        expect(text(copy({ metadata: 'none', when: 'once' }))).toBe(
            'Copy the files in /tmp/a to /tmp/b. Just once.'
        )
        expect(
            text(
                copy({
                    metadata: 'keep',
                    when: 'schedule',
                    schedule: DEFAULT_WHEN,
                    keep: 'template',
                    templateName: 'Nightly',
                })
            )
        ).toBe(
            'Copy the files in /tmp/a to /tmp/b. Metadata included. Every day at 02:00. Settings kept as the template ‘Nightly’.'
        )
        expect(text(copy({ sources: ['/tmp/a', '/tmp/c'] }))).toBe(
            'Copy the files in /tmp/a and 1 more to /tmp/b.'
        )
    })

    it('leaves blanks for the places still to pick', () => {
        const blanks = (answers: Answers) =>
            sentence(answers)
                .filter((segment) => !segment.filled)
                .map((segment) => segment.text)
        expect(blanks({ goal: 'transfer' })).toEqual(['somewhere', 'somewhere'])
        expect(blanks(copy({ destination: undefined }))).toEqual(['somewhere'])
        expect(blanks({ goal: 'download', destination: '/tmp' })).toEqual(['a link'])
        expect(blanks(copy())).toEqual([])
        expect(text({ goal: 'clear', refine: 'purge', sources: ['/tmp/a', '/tmp/c'] })).toBe(
            'Delete /tmp/a and 1 more and everything in them.'
        )
        expect(text({ goal: 'clear', refine: 'purge' })).toBe(
            'Delete somewhere and everything in it.'
        )
    })

    it('says a schedule as the Schedules window does', () => {
        const at = (schedule: Answers['schedule']) =>
            whenPhrase(copy({ when: 'schedule', schedule }))
        expect(at({ ...DEFAULT_WHEN, kind: 'weekday', hour: 6, minute: 30 })).toBe(
            'Every weekday at 06:30'
        )
        expect(at({ ...DEFAULT_WHEN, kind: 'custom', expression: '*/5 * * * *' })).toBe(
            'On the schedule */5 * * * *'
        )
        expect(metadataPhrase(copy({ metadata: 'map', mapper: ONE_RULE }))).toBe('Yes, with 1 rule')
    })
})

describe('routeFor', () => {
    it('opens a transfer page with a preset of its form', () => {
        const route = routeFor(copy({ metadata: 'map', mapper: ONE_RULE, when: 'once' }))
        expect(route?.startsWith('/copy?preset=')).toBe(true)
        expect(presetOf(route)).toEqual({
            operation: 'copy',
            copy: {
                sources: ['/tmp/a'],
                destination: '/tmp/b',
                options: { metadata: { metadata: true, metadata_mapper: ONE_RULE } },
            },
        })
    })

    it('gives a scheduled plan its time, which opens the Schedule drawer', () => {
        const sync: Answers = {
            goal: 'match',
            refine: 'sync',
            sources: ['gdrive:Photos'],
            destination: '/tmp/b',
            metadata: 'none',
            when: 'schedule',
            schedule: { ...DEFAULT_WHEN, kind: 'week', weekday: 0 },
        }
        expect(presetOf(routeFor(sync))).toEqual({
            operation: 'sync',
            sync: { source: 'gdrive:Photos', destination: '/tmp/b' },
            when: '0 2 * * 0',
        })
        const purge: Answers = { goal: 'clear', refine: 'purge', sources: ['gdrive:old'] }
        expect(presetOf(routeFor(purge))).toEqual({
            operation: 'purge',
            purge: { sources: ['gdrive:old'] },
        })
    })

    it('opens Mount, Serve and Download with their paths in the query', () => {
        expect(routeFor({ goal: 'mount', sources: ['gdrive:'], destination: '/tmp/m' })).toBe(
            '/mount?initialSource=gdrive%3A&initialDestination=%2Ftmp%2Fm'
        )
        expect(routeFor({ goal: 'share', refine: 'webdav', sources: ['/tmp/a'] })).toBe(
            '/serve?initialSource=%2Ftmp%2Fa&initialType=webdav'
        )
        expect(
            routeFor({ goal: 'download', url: ' https://x.io/a.zip ', destination: '/tmp' })
        ).toBe('/download?initialUrl=https%3A%2F%2Fx.io%2Fa.zip&initialDestination=%2Ftmp')
        expect(routeFor({ goal: 'transfer' })).toBeUndefined()
    })
})

describe('templateFor', () => {
    it('keeps the places and the metadata options under the name', () => {
        expect(templateFor(copy({ keep: 'once' }))).toBeUndefined()
        expect(
            templateFor(copy({ metadata: 'keep', keep: 'template', templateName: ' Nightly ' }))
        ).toEqual({
            name: 'Nightly',
            tags: ['copy'],
            options: { metadata: true },
            paths: { sources: ['/tmp/a'], destination: '/tmp/b' },
        })
        expect(
            templateFor({
                goal: 'share',
                refine: 'http',
                sources: ['/tmp/a'],
                keep: 'template',
                templateName: 'Share',
            })
        ).toEqual({
            name: 'Share',
            tags: ['serve'],
            options: {},
            paths: { sources: ['/tmp/a'], destination: '' },
        })
    })
})
