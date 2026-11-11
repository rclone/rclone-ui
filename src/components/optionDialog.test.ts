import { describe, expect, it } from 'vitest'
import { Kind, Option } from '../../lib/catalog'
import { answerOf, initialAnswer } from './optionDialog'

const choices = (...values: string[]) => values.map((value) => ({ value, help: '' }))

describe('the option dialog', () => {
    it('answers a switch with true or false', () => {
        const on = new Option({ name: 'shared', kind: Kind.KindBool, defaultText: 'true' })
        const off = new Option({ name: 'shared', kind: Kind.KindBool, defaultText: '' })
        expect(answerOf(on, undefined)).toBe('true')
        expect(answerOf(off, undefined)).toBe('false')
        expect(answerOf(off, 'true')).toBe('true')
        expect(answerOf(on, 'false')).toBe('false')
    })

    it('starts from the default, or the first choice when a closed set has none', () => {
        const closed = new Option({
            name: 'scope',
            kind: Kind.KindText,
            exclusive: true,
            choices: choices('drive', 'drive.file'),
        })
        expect(initialAnswer(closed)).toBe('drive')
        expect(initialAnswer(new Option({ ...closed, defaultText: 'drive.file' }))).toBe(
            'drive.file'
        )
        expect(answerOf(closed, 'drive.file')).toBe('drive.file')
    })

    it('keeps a typed value in an open set, even one that starts with a digit', () => {
        const open = new Option({
            name: 'root_folder_id',
            kind: Kind.KindText,
            defaultText: 'custom',
            choices: choices('a', 'b'),
        })
        expect(initialAnswer(open)).toBe('custom')
        expect(answerOf(open, '1f3a9c')).toBe('1f3a9c')
        expect(initialAnswer(new Option({ ...open, defaultText: '' }))).toBe('a')
    })

    it('sends text as it was typed, and an emptied field as empty', () => {
        const text = new Option({ name: 'client_id', kind: Kind.KindText, defaultText: 'x' })
        expect(answerOf(text, undefined)).toBe('x')
        expect(answerOf(text, '')).toBe('')
        expect(answerOf(text, ' id ')).toBe(' id ')
    })
})
