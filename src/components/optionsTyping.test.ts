import { expect, test } from 'vitest'
import { type Typed, typeEnter, typeQuote } from './optionsTyping'

// The editor's text with `|` where the cursor is. undefined leaves the key to the textarea.
const marked = (r: Typed | undefined) =>
    r && `${r.text.slice(0, r.cursor)}|${r.text.slice(r.cursor)}`
const type = (key: typeof typeQuote, text: string) => {
    const cursor = text.indexOf('|')
    return marked(key(text.replace('|', ''), cursor, cursor))
}

test.each([
    ['opens a key with its closing quote', '{|}', '{"|"}'],
    ['opens a value', '{"a": |}', '{"a": "|"}'],
    ['opens a string in a list', '["x", |]', '["x", "|"]'],
    ['opens a key on its own line', '{\n  |\n}', '{\n  "|"\n}'],
    ['closes a key it opened by stepping over the quote', '{"transfers|"}', '{"transfers"|}'],
    ['closes a value by stepping over the quote', '{"a": "x|"}', '{"a": "x"|}'],
    ['closes a key typed without its quote as usual', '{"transfers|}', undefined],
    ['before a quote, without adding another', '{"a": |"x"}', undefined],
    ['steps over the quote after an escaped one', '{"a\\"b|"}', '{"a\\"b"|}'],
    ['after a backslash, as usual', '{"a": "x\\|"}', undefined],
])('a quote %s', (_, text, want) => {
    expect(type(typeQuote, text)).toBe(want)
})

test.each([
    ['right after an object’s {', '{|}', '{\n  "|": ""\n}'],
    [
        'at the end of an option’s line',
        '{\n  "transfers": 4|\n}',
        '{\n  "transfers": 4,\n  "|": ""\n}',
    ],
    ['after a list', '{\n  "a": ["x"]|\n}', '{\n  "a": ["x"],\n  "|": ""\n}'],
    ['after a line with its comma', '{\n  "a": true,|\n}', '{\n  "a": true,\n  "|": ""\n}'],
    [
        'after a line with its comma, before another option',
        '{\n  "a": 1,|\n  "b": 2\n}',
        '{\n  "a": 1,\n  "|": "",\n  "b": 2\n}',
    ],
    [
        'right after the { of an object with options',
        '{|\n  "a": 1\n}',
        '{\n  "|": "",\n  "a": 1\n}',
    ],
    ['before the } of a one-line object', '{"a": 1|}', '{"a": 1,\n  "|": ""\n}'],
    [
        'in an object in an object',
        '{\n  "a": {\n    "b": 1|\n  }\n}',
        '{\n  "a": {\n    "b": 1,\n    "|": ""\n  }\n}',
    ],
    ['in a list', '{\n  "exclude": [\n    "*.tmp"|\n  ]\n}', undefined],
    ['in an empty list', '{\n  "exclude": [|]\n}', undefined],
    ['in a string', '{"a": "x|y"}', undefined],
    ['before the rest of a line', '{"a": |1}', undefined],
    ['after a key waiting for its value', '{"a":|}', undefined],
    ['outside any object', '|', undefined],
])('Enter %s', (_, text, want) => {
    expect(type(typeEnter, text)).toBe(want)
})

test('a selection is typed over as usual', () => {
    expect(typeQuote('{"a": 1}', 6, 7)).toBeUndefined()
    expect(typeEnter('{"a": 1}', 6, 7)).toBeUndefined()
})
