/**
 * Reads and writes rclone.json, rclone's own text: a tree keyed by backend, option block and option
 * name (build/i18n/rclone.go). It is written as Go's encoding/json writes it there: keys sorted,
 * two spaces of indent, HTML characters as they are, and a line break at the end.
 */

export type Texts = [key: string[], text: string][]

export function flattenTexts(tree: unknown, prefix: string[] = [], out: Texts = []): Texts {
    if (typeof tree === 'string') {
        out.push([prefix, tree])
    } else if (tree && typeof tree === 'object') {
        for (const [k, v] of Object.entries(tree)) flattenTexts(v, [...prefix, k], out)
    }
    return out
}

/** Compares as Go compares strings, byte by byte in UTF-8, which is the order of code points. */
function compareKeys(a: string, b: string) {
    const x = Array.from(a)
    const y = Array.from(b)
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = (x[i].codePointAt(0) ?? 0) - (y[i].codePointAt(0) ?? 0)
        if (d !== 0) return d
    }
    return x.length - y.length
}

function goString(s: string) {
    let out = '"'
    for (const ch of s) {
        const c = ch.codePointAt(0) ?? 0
        if (ch === '"' || ch === '\\') out += `\\${ch}`
        else if (ch === '\n') out += '\\n'
        else if (ch === '\r') out += '\\r'
        else if (ch === '\t') out += '\\t'
        else if (ch === '\b') out += '\\b'
        else if (ch === '\f') out += '\\f'
        else if (c < 0x20 || c === 0x2028 || c === 0x2029) {
            out += `\\u${c.toString(16).padStart(4, '0')}`
        } else out += ch
    }
    return `${out}"`
}

interface Tree {
    [key: string]: Tree | string
}

function writeNode(node: Tree | string, indent: string): string {
    if (typeof node === 'string') return goString(node)
    const keys = Object.keys(node).sort(compareKeys)
    if (keys.length === 0) return '{}'
    const inner = `${indent}  `
    const items = keys.map((k) => `${inner}${goString(k)}: ${writeNode(node[k], inner)}`)
    return `{\n${items.join(',\n')}\n${indent}}`
}

export function writeTexts(texts: Texts): string {
    const tree: Tree = {}
    for (const [key, text] of texts) {
        let node = tree
        for (const part of key.slice(0, -1)) {
            const next = node[part]
            node[part] = typeof next === 'object' ? next : {}
            node = node[part] as Tree
        }
        node[key[key.length - 1]] = text
    }
    return `${writeNode(tree, '')}\n`
}

const HELP_VARIANT = /^help(_[0-9]+)?$/

/**
 * Whether the text at key is a setup question's or error's, which are fmt formats, and not a
 * choice's help, which is plain text (setupFormat in build/i18n/rclone.go).
 */
export function isSetupFormat(key: string[]) {
    const n = key.length
    if (key[0] !== 'setup' || !HELP_VARIANT.test(key[n - 1])) return false
    if (n === 3) return key[1] === 'error'
    if (n === 4) return key[1] === 'question'
    if (n === 5) return key[1] === 'backend' && key[3] === 'error'
    if (n === 6) return key[1] === 'backend' && key[3] === 'question'
    return false
}
