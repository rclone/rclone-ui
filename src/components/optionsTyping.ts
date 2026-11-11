// What `"` and Enter do in the options editor, whose text is one JSON object of options. When a
// function returns undefined, the textarea handles the key as usual.

export interface Typed {
    text: string
    cursor: number
}

/**
 * Describes where `at` is in JSON text: whether it is inside a string, whether the next
 * character is escaped (right after a backslash in a string), and which brackets are open around
 * it, with the innermost last.
 */
function scan(text: string, at: number) {
    const open: string[] = []
    let inString = false
    let escaped = false
    for (let i = 0; i < at; i++) {
        const char = text[i]
        if (inString) {
            if (escaped) escaped = false
            else if (char === '\\') escaped = true
            else if (char === '"') inString = false
        } else if (char === '"') inString = true
        else if (char === '{' || char === '[') open.push(char)
        else if (char === '}' || char === ']') open.pop()
    }
    return { inString, escaped, open }
}

/**
 * Handles typing `"` at the cursor (`start` to `end`, which is a selection when they differ).
 * Outside a string, it inserts a pair of quotes, unless a quote is already right after the
 * cursor. Inside a string, it moves past a closing quote that is right after the cursor.
 */
export function typeQuote(text: string, start: number, end: number): Typed | undefined {
    if (start !== end) return undefined
    const at = scan(text, start)
    if (at.inString) {
        return !at.escaped && text[start] === '"' ? { text, cursor: start + 1 } : undefined
    }
    if (text[start] === '"') return undefined
    return { text: `${text.slice(0, start)}""${text.slice(start)}`, cursor: start + 1 }
}

const INDENT = '  '
const LINE_SPACE = /^[ \t]*/

/**
 * Handles Enter at the cursor. At the end of an option's line in an object (or right after its
 * `{`), it starts a new option with the comma the line needs, and a comma after it when more
 * options follow. The cursor goes between the new key's quotes. Anywhere else (in a list, in a
 * string, before the rest of a line, after a key waiting for its value) the textarea inserts a
 * plain new line.
 */
export function typeEnter(text: string, start: number, end: number): Typed | undefined {
    if (start !== end) return undefined
    const at = scan(text, start)
    const depth = at.open.length
    if (at.inString || at.open[depth - 1] !== '{') return undefined
    const lineEnd = text.indexOf('\n', start)
    const rest = text.slice(start, lineEnd === -1 ? text.length : lineEnd).trim()
    if (rest !== '' && !rest.startsWith('}')) return undefined

    const head = text.slice(0, start).trimEnd()
    const last = head[head.length - 1]
    if (last === ':') return undefined
    const comma = last === '{' || last === ',' ? '' : ','
    let tail = text.slice(start).replace(LINE_SPACE, '')
    const next = tail.trimStart()[0]
    if (tail.startsWith('}')) tail = `\n${INDENT.repeat(depth - 1)}${tail}`
    const before = `${head}${comma}\n${INDENT.repeat(depth)}"`
    const own = next === undefined || next === '}' ? '' : ','
    return { text: `${before}": ""${own}${tail}`, cursor: before.length }
}
