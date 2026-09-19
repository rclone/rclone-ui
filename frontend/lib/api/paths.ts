// Well-known directories and lexical path helpers, all synchronous (from the boot script).

import { boot } from './boot'

export const sep = boot.paths.sep
export const delimiter = boot.paths.delimiter
export const home = boot.paths.home ?? ''
export const temp = boot.paths.temp
/** The UI's own binary, which rclone runs as the metadata mapper (`lib/rclone/metadataMapper.ts`). */
export const exe = boot.paths.exe ?? ''
export const download = boot.paths.download ?? ''
export const desktop = boot.paths.desktop ?? ''

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/

function isSeparator(ch: string): boolean {
    return ch === '/' || ch === '\\'
}

/** Lexical normalization (`.` / `..`, duplicate separators), no filesystem access. */
export function normalize(path: string): string {
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

export function basename(path: string, ext?: string): string {
    const trimmed = path.replace(/[\\/]+$/, '')
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    let base = index === -1 ? trimmed : trimmed.slice(index + 1)
    if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length)
    return base
}

export function extname(path: string): string {
    const base = basename(path)
    const dot = base.lastIndexOf('.')
    return dot <= 0 ? '' : base.slice(dot)
}

export function isAbsolute(path: string): boolean {
    return isSeparator(path[0] ?? '') || WINDOWS_DRIVE.test(path)
}
