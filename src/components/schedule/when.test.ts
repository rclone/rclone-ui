import { describe, expect, it } from 'vitest'
import {
    DEFAULT_WHEN,
    fromCron,
    nextRunsLine,
    nextRunText,
    runsSentence,
    shortTime,
    toCron,
    type WhenForm,
    whenInWords,
} from './when'

const form = (over: Partial<WhenForm>): WhenForm => ({ ...DEFAULT_WHEN, ...over })

describe('toCron', () => {
    it('writes each choice', () => {
        expect(toCron(form({ kind: 'hour', minute: 15 }))).toBe('15 * * * *')
        expect(toCron(form({ kind: 'day', hour: 2, minute: 0 }))).toBe('0 2 * * *')
        expect(toCron(form({ kind: 'weekday', hour: 9, minute: 30 }))).toBe('30 9 * * 1-5')
        expect(toCron(form({ kind: 'week', weekday: 0, hour: 23, minute: 5 }))).toBe('5 23 * * 0')
        expect(toCron(form({ kind: 'month', monthDay: 28, hour: 4, minute: 0 }))).toBe('0 4 28 * *')
        expect(toCron(form({ kind: 'custom', expression: '  */5 * * * * ' }))).toBe('*/5 * * * *')
    })
    it('opens a new schedule as every day at 02:00', () => {
        expect(toCron(DEFAULT_WHEN)).toBe('0 2 * * *')
    })
})

describe('fromCron', () => {
    it('reads back what each choice writes', () => {
        const forms: WhenForm[] = [
            form({ kind: 'hour', minute: 45 }),
            form({ kind: 'day', hour: 7, minute: 10 }),
            form({ kind: 'weekday', hour: 18, minute: 0 }),
            form({ kind: 'week', weekday: 3, hour: 12, minute: 0 }),
            form({ kind: 'week', weekday: 0, hour: 12, minute: 0 }),
            form({ kind: 'month', monthDay: 15, hour: 1, minute: 30 }),
        ]
        for (const f of forms) {
            const back = fromCron(toCron(f))
            expect(back.kind).toBe(f.kind)
            expect(toCron(back)).toBe(toCron(f))
        }
    })
    it('opens the aliases as their choices', () => {
        expect(fromCron('@hourly')).toMatchObject({ kind: 'hour', minute: 0 })
        expect(fromCron('@daily')).toMatchObject({ kind: 'day', hour: 0, minute: 0 })
        expect(fromCron('@weekly')).toMatchObject({ kind: 'week', weekday: 0, hour: 0 })
        expect(fromCron('@monthly')).toMatchObject({ kind: 'month', monthDay: 1, hour: 0 })
    })
    it('reads names, Sunday as 7, and padded numbers', () => {
        expect(fromCron('0 9 * * MON-FRI').kind).toBe('weekday')
        expect(fromCron('0 9 * * mon')).toMatchObject({ kind: 'week', weekday: 1 })
        expect(fromCron('0 9 * * 7')).toMatchObject({ kind: 'week', weekday: 0 })
        expect(fromCron('05 02 * * *')).toMatchObject({ kind: 'day', hour: 2, minute: 5 })
    })
    it('opens any other expression as Custom, as it is', () => {
        for (const expression of [
            '*/5 * * * *',
            '0 2 31 * *',
            '0 2 29 * *',
            '0 2 1 1 *',
            '0 2 * * 1,3',
            '0 2 1 * 1',
            '0 */2 * * *',
            '60 2 * * *',
            '0 24 * * *',
            '@yearly',
            '@every 5m',
            '0 2 * *',
            '',
        ]) {
            expect(fromCron(expression)).toMatchObject({ kind: 'custom', expression })
        }
    })
})

describe('whenInWords', () => {
    it('says each choice in words', () => {
        expect(whenInWords('5 * * * *')).toBe('Every hour at :05')
        expect(whenInWords('0 2 * * *')).toBe('Every day at 02:00')
        expect(whenInWords('30 9 * * 1-5')).toBe('Every weekday at 09:30')
        expect(whenInWords('0 18 * * 5')).toBe('Every Friday at 18:00')
        expect(whenInWords('0 0 * * 0')).toBe('Every Sunday at 00:00')
        expect(whenInWords('0 3 1 * *')).toBe('Every month on the 1st at 03:00')
        expect(whenInWords('@daily')).toBe('Every day at 00:00')
    })
    it('has no words for Custom', () => {
        expect(whenInWords('*/10 * * * *')).toBeNull()
    })
})

describe('the day of the month', () => {
    it('is an ordinal', () => {
        const days = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28]
        expect(days.map((day) => whenInWords(`0 3 ${day} * *`))).toEqual([
            'Every month on the 1st at 03:00',
            'Every month on the 2nd at 03:00',
            'Every month on the 3rd at 03:00',
            'Every month on the 4th at 03:00',
            'Every month on the 11th at 03:00',
            'Every month on the 12th at 03:00',
            'Every month on the 13th at 03:00',
            'Every month on the 21st at 03:00',
            'Every month on the 22nd at 03:00',
            'Every month on the 23rd at 03:00',
            'Every month on the 28th at 03:00',
        ])
    })
})

describe('runsSentence', () => {
    it('says when the schedule runs', () => {
        expect(runsSentence('Photos', '0 2 * * *')).toBe('Photos runs every day at 02:00.')
        expect(runsSentence('Photos', '5 * * * *')).toBe('Photos runs every hour at :05.')
        expect(runsSentence('Photos', '0 18 * * 5')).toBe('Photos runs every Friday at 18:00.')
        expect(runsSentence('Photos', '0 3 22 * *')).toBe(
            'Photos runs every month on the 22nd at 03:00.'
        )
        expect(runsSentence('Logs', '*/5 * * * *')).toBe(
            'Logs runs on the cron schedule */5 * * * *.'
        )
    })
})

describe('times', () => {
    const at = new Date(2026, 10, 9, 2, 0).getTime() // Monday 9 November 2026, 02:00
    it('formats a time as the drawer shows it', () => {
        expect(shortTime(at)).toBe('Mon, Nov 9, 02:00')
        expect(nextRunsLine([at, at + 86_400_000], 'EET')).toBe(
            'Next runs: Mon, Nov 9, 02:00 · Tue, Nov 10, 02:00 (EET)'
        )
        expect(nextRunsLine([at], '')).toBe('Next runs: Mon, Nov 9, 02:00')
    })
    it('says the next run from now, or its date when it is more than a day away', () => {
        expect(nextRunText(null, at)).toBe('')
        expect(nextRunText(at, at - 3 * 3_600_000)).toBe('Next run in 3 hours')
        expect(nextRunText(at, at - 2 * 86_400_000)).toBe('Next run Mon, Nov 9, 02:00')
        expect(nextRunText(at, at + 1000)).toBe('Next run soon')
    })
})
