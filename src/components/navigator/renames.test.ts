import { expect, test } from 'vitest'
import { renamesDone } from './renames'

const SENT = ['a.txt', 'b.txt', 'c', 'd.txt']
const step = (step: number | null) => ({ step })

// After a batch partly fails, Apply sends only the renames that failed. If it also sent a rename
// that already completed, the core would refuse the whole batch, because that new name is now
// taken (by the renamed item itself).
test('a failed batch made every rename its failures do not name', () => {
    expect(renamesDone('failed', SENT, [step(1), step(3)])).toEqual(['a.txt', 'c'])
    // A folder rename that failed for some of its files lists its step once for each file.
    expect(renamesDone('failed', SENT, [step(2), step(2), step(0)])).toEqual(['b.txt', 'd.txt'])
    expect(renamesDone('failed', SENT, [0, 1, 2, 3].map(step))).toEqual([])
})

test('without a word of each step, no rename is known to have run', () => {
    // When a batch is stopped or interrupted, the steps that never started aren't failures.
    expect(renamesDone('stopped', SENT, [step(1)])).toEqual([])
    expect(renamesDone('interrupted', SENT, [step(1)])).toEqual([])
    // A failure without a step, or a failed batch with no failures of its own.
    expect(renamesDone('failed', SENT, [step(1), step(null)])).toEqual([])
    expect(renamesDone('failed', SENT, [])).toEqual([])
    expect(renamesDone('completed', SENT, [])).toEqual([])
})
