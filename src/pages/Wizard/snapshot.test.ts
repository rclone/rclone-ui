import { describe, expect, it } from 'vitest'
import { DEFAULT_WHEN } from '../../components/schedule/when'
import { INITIAL, loadState, readState, saveState } from './snapshot'

function memoryStorage(): Storage {
    const items = new Map<string, string>()
    return {
        get length() {
            return items.size
        },
        clear: () => items.clear(),
        getItem: (key) => items.get(key) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (key) => {
            items.delete(key)
        },
        setItem: (key, value) => {
            items.set(key, value)
        },
    }
}

describe('readState', () => {
    it('keeps the answers it can read and asks the others again', () => {
        expect(
            readState({
                answers: {
                    goal: 'transfer',
                    refine: 'webdav', // not one of the transfer's choices
                    sources: ['/tmp/a', 3],
                    destination: '/tmp/b',
                    when: 'schedule',
                    schedule: { ...DEFAULT_WHEN, hour: 'two' },
                    keep: 'forever',
                },
                cursor: 2,
            })
        ).toEqual({
            answers: { goal: 'transfer', destination: '/tmp/b', when: 'schedule' },
            cursor: 2,
        })
    })

    it('starts afresh from what it cannot read', () => {
        expect(readState(null)).toEqual(INITIAL)
        expect(readState({ answers: {}, cursor: -1 })).toEqual(INITIAL)
    })
})

describe('loadState and saveState', () => {
    it('keep the Wizard as it was left', () => {
        const storage = memoryStorage()
        const state = {
            answers: { goal: 'clear' as const, refine: 'purge' as const, sources: ['e2e:old'] },
            cursor: 2,
            editing: { goal: 'clear' as const },
        }
        saveState('wizard:/data', state, storage)
        expect(loadState('wizard:/data', storage)).toEqual(state)
        expect(loadState('wizard:/other', storage)).toEqual(INITIAL)
        storage.setItem('wizard:/data', '{')
        expect(loadState('wizard:/data', storage)).toEqual(INITIAL)
    })
})
