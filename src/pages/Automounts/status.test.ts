import { describe, expect, it } from 'vitest'
import type { Mounts } from '../../../lib/core/types'
import { matchAny } from '../../components/list/list'
import { canMountNow, deleteQuestion, searchFields, statusOf, summaryOf } from './status'

function automount(over: Partial<Mounts.AutomountRow> = {}): Mounts.AutomountRow {
    return {
        id: 'a',
        remote: 'gdrive',
        remotePath: 'Photos',
        mountPoint: '/Users/me/Rclone/gdrive',
        options: {},
        enabled: true,
        createdAt: 1,
        mountId: '',
        remoteMissing: false,
        ...over,
    }
}

describe('statusOf', () => {
    it('says whether it is mounted', () => {
        expect(statusOf(automount())).toEqual({ label: 'Not mounted', kind: 'idle' })
        expect(statusOf(automount({ mountId: 'm1' }))).toEqual({
            label: 'Mounted',
            kind: 'success',
        })
    })

    it('says first that the remote is missing', () => {
        expect(statusOf(automount({ remoteMissing: true }))).toEqual({
            label: 'Remote missing',
            kind: 'warning',
        })
        expect(statusOf(automount({ remoteMissing: true, mountId: 'm1' })).label).toBe(
            'Remote missing'
        )
    })
})

describe('canMountNow', () => {
    it('offers it for one that is on and not mounted', () => {
        expect(canMountNow(automount())).toBe(true)
    })

    it('doesn’t offer it when it is off, mounted, or its remote is missing', () => {
        expect(canMountNow(automount({ enabled: false }))).toBe(false)
        expect(canMountNow(automount({ mountId: 'm1' }))).toBe(false)
        expect(canMountNow(automount({ remoteMissing: true }))).toBe(false)
    })
})

describe('deleteQuestion', () => {
    it('names the source', () => {
        expect(deleteQuestion(automount())).toBe(
            'Delete the automount of gdrive:Photos? A mount it started keeps running.'
        )
    })
})

describe('searchFields', () => {
    const list = [
        automount({ id: '1' }),
        automount({ id: '2', remote: 'dropbox', remotePath: '', mountPoint: '/Volumes/Box' }),
    ]

    it('finds the source or the mount point, ignoring case', () => {
        expect(matchAny(list, 'PHOTOS', searchFields).map((a) => a.id)).toEqual(['1'])
        expect(matchAny(list, 'volumes/box', searchFields).map((a) => a.id)).toEqual(['2'])
        expect(matchAny(list, 'dropbox:', searchFields).map((a) => a.id)).toEqual(['2'])
    })
})

it('summaryOf counts the mounted, the off and the missing', () => {
    expect(summaryOf([automount({ mountId: 'm' }), automount()])).toBe('1 of 2 mounted.')
    expect(summaryOf([automount({ enabled: false }), automount({ remoteMissing: true })])).toBe(
        '0 of 2 mounted. 1 off. 1 remote is missing.'
    )
})
