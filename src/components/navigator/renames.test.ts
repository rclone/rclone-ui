import { expect, test } from 'vitest'
import { renamesDone } from './renames'

const SENT = ['a.txt', 'b.txt', 'c', 'd.txt']
const step = (step: number | null) => ({ step })

test('a failed batch made every rename its failures do not name', () => {
    expect(renamesDone('failed', SENT, [step(1), step(3)])).toEqual(['a.txt', 'c'])
    expect(renamesDone('failed', SENT, [step(2), step(2), step(0)])).toEqual(['b.txt', 'd.txt'])
    expect(renamesDone('failed', SENT, [0, 1, 2, 3].map(step))).toEqual([])
})

test('without a word of each step, no rename is known to have run', () => {
    expect(renamesDone('stopped', SENT, [step(1)])).toEqual([])
    expect(renamesDone('interrupted', SENT, [step(1)])).toEqual([])
    expect(renamesDone('failed', SENT, [step(1), step(null)])).toEqual([])
    expect(renamesDone('failed', SENT, [])).toEqual([])
    expect(renamesDone('completed', SENT, [])).toEqual([])
})
