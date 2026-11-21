import type { Kind } from './types.ts'

/**
 * A short id for a text (cyrb53). The site's build and the browser make the same id from the same
 * text, so saved work finds its text again after the site is rebuilt. A text whose English changes
 * gets a new id, and so shows as not translated.
 */
function hash(text: string): string {
    let h1 = 0xdeadbeef
    let h2 = 0x41c6ce57
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        h1 = Math.imul(h1 ^ c, 2654435761)
        h2 = Math.imul(h2 ^ c, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export function poId(kind: Exclude<Kind, 'rclone'>, ctx: string, text: string, plural: string) {
    return hash([kind, ctx, text, plural].join('\u0004'))
}

export function rcloneId(key: string[], text: string) {
    return hash(['rclone', key.join('\u0000'), text].join('\u0004'))
}
