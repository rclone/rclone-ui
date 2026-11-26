import { expect, test } from 'vitest'
import type { Bus } from '../core/types'
import { splitFiles } from './details'

type TransferredFile = Bus.TransferredFile

test('files go to the section that says how they ended', () => {
    const fine: TransferredFile = { name: 'fine.txt', size: 1, bytes: 1 }
    const locked: TransferredFile = { name: 'locked.txt', size: 1, bytes: 0, error: 'denied' }
    expect(splitFiles([fine, locked])).toEqual({ transferred: [fine], failed: [locked] })
    expect(splitFiles(undefined)).toEqual({ transferred: [], failed: [] })
    const early: TransferredFile = { name: 'early.txt', size: 1, bytes: 0, error: 'quota' }
    expect(splitFiles([fine, locked], [early, locked])).toEqual({
        transferred: [fine],
        failed: [early, locked],
    })
})
