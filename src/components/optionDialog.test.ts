import { describe, expect, it } from 'vitest'
import { Kind, Option } from '../../lib/catalog'
import {
    answerOf,
    initialAnswer,
    initialPick,
    isChoiceQuestion,
    OTHER_VALUE,
    pickedAnswer,
    takesOtherValue,
} from './optionDialog'

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

// OneDrive's drive question as rclone v1.75.1 asks it, for an account whose first drive in
// /me/drives is stale. rclone's default is the first drive, as on its command line.
const DRIVE_QUESTION = new Option({
    name: 'config_driveid',
    help: 'Select drive you want to use',
    kind: Kind.KindText,
    defaultText: 'b!STALE0000',
    required: true,
    exclusive: false,
    choices: [
        { value: 'b!STALE0000', help: 'OneDrive (personal)' },
        { value: '9A8B7C6D5E4F3A2B', help: 'OneDrive (personal)' },
    ],
})

describe('a question with choices', () => {
    it('lists them all, like the drive question, rather than a text field', () => {
        expect(isChoiceQuestion(DRIVE_QUESTION)).toBe(true)
        expect(isChoiceQuestion(new Option({ ...DRIVE_QUESTION, exclusive: true }))).toBe(true)
        const yesNo = new Option({
            name: 'config_drive_ok',
            kind: Kind.KindBool,
            defaultText: 'true',
        })
        expect(isChoiceQuestion(yesNo)).toBe(false)
        expect(isChoiceQuestion(new Option({ name: 'config_token', kind: Kind.KindText }))).toBe(
            false
        )
    })

    it("starts from rclone's default, and sends the choice that was picked", () => {
        expect(initialPick(DRIVE_QUESTION)).toEqual({ pick: 'b!STALE0000', typed: '' })
        expect(pickedAnswer('9A8B7C6D5E4F3A2B', '')).toBe('9A8B7C6D5E4F3A2B')
    })

    it('takes another value only when rclone accepts one', () => {
        expect(takesOtherValue(DRIVE_QUESTION)).toBe(true)
        expect(takesOtherValue(new Option({ ...DRIVE_QUESTION, exclusive: true }))).toBe(false)
        expect(pickedAnswer(OTHER_VALUE, 'ABCDEF123')).toBe('ABCDEF123')
    })

    it('starts on another value when the default is none of the choices', () => {
        const open = new Option({ ...DRIVE_QUESTION, defaultText: 'typed-before' })
        expect(initialPick(open)).toEqual({ pick: OTHER_VALUE, typed: 'typed-before' })
    })
})
