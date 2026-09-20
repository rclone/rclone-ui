// The server's home folder and separator (from the boot script), and lexical helpers for paths
// on the server's disk.

import { boot } from './boot'

export const sep = boot.paths.sep
export const home = boot.paths.home ?? ''
/** The UI's own binary, which rclone runs as the metadata mapper (`lib/rclone/metadataMapper.ts`). */
export const exe = boot.paths.exe ?? ''

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/

function isSeparator(ch: string): boolean {
    return ch === '/' || ch === '\\'
}

/** Lexical normalization (`.` / `..`, duplicate separators), no filesystem access. */
function normalize(path: string): string {
    if (!path) return ''
    const windows = sep === '\\'
    let prefix = ''
    let rest = path
    if (windows && WINDOWS_DRIVE.test(path)) {
        prefix = path.slice(0, 2) + sep
        rest = path.slice(3)
    } else if (isSeparator(path[0]!)) {
        prefix = sep
        rest = path.slice(1)
    }
    const out: string[] = []
    for (const part of rest.split(/[\\/]+/)) {
        if (!part || part === '.') continue
        if (part === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop()
            else if (!prefix) out.push('..')
            continue
        }
        out.push(part)
    }
    return prefix + out.join(sep)
}

export function join(...parts: string[]): string {
    const filtered = parts.filter((p) => p !== undefined && p !== null && p !== '')
    if (filtered.length === 0) return ''
    return normalize(filtered.join(sep))
}

export function dirname(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '')
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    if (index === -1) return '.'
    if (index === 0) return trimmed[0]!
    if (sep === '\\' && index === 2 && WINDOWS_DRIVE.test(trimmed)) return trimmed.slice(0, 3)
    return trimmed.slice(0, index)
}
