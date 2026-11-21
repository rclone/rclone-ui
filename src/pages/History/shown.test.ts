import { describe, expect, it } from 'vitest'
import { endedStateOf, readShown, saveShown } from './shown'

function memory() {
    const values = new Map<string, string>()
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
            values.set(key, value)
        },
    }
}

describe('readShown', () => {
    it('starts at All with no search', () => {
        expect(readShown(memory())).toEqual({ status: 'all', search: '' })
        expect(readShown(undefined)).toEqual({ status: 'all', search: '' })
    })

    it('finds the tab and the search as they were left', () => {
        const storage = memory()
        saveShown({ status: 'failed', search: '#12' }, storage)
        expect(readShown(storage)).toEqual({ status: 'failed', search: '#12' })
    })

    it('drops what it cannot read', () => {
        const storage = memory()
        storage.setItem('history', '{"status":"nope","search":3}')
        expect(readShown(storage)).toEqual({ status: 'all', search: '' })
        storage.setItem('history', 'not json')
        expect(readShown(storage)).toEqual({ status: 'all', search: '' })
    })
})

describe('endedStateOf', () => {
    it('asks the core for one end only on the end tabs', () => {
        expect(endedStateOf('all')).toBe('')
        expect(endedStateOf('running')).toBe('')
        expect(endedStateOf('completed')).toBe('completed')
        expect(endedStateOf('stopped')).toBe('stopped')
    })
})
