export interface Typed {
    text: string
    cursor: number
}

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
