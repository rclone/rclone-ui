import { plural, t } from '@lingui/core/macro'
import { buildReadablePath } from '../../../lib/format'
import type { OperationSubset } from '../../../lib/operations'

// The sentence at the left of an operation page's action bar, which says what pressing its button
// will do ("Copy Photos to gdrive:Backup"), with a line under it about what that means for the
// files. The places in it are stressed.
//
// Each sentence is one message, so that a language can put its words in its own order. A stressed
// part goes into the message as a value that is marked (`stressed`), and `segments` finds the
// marks in the translated sentence:
//
//     segments(t`Mount ${stressed(source)} at ${stressed(mountPoint)}`)

export interface Segment {
    text: string
    strong?: boolean
}

/** What the action bar says: a sentence in segments, and a line under it. */
export interface BarLine {
    title: Segment[]
    detail?: string
}

// Two characters from Unicode's private use area, which no path or translation contains.
const OPEN = ''
const CLOSE = ''

/** Marks a value of a sentence as stressed. `segments` shows it strong, without the marks. */
export function stressed(text: string): string {
    return `${OPEN}${text}${CLOSE}`
}

/** Splits a translated sentence into its segments, at the marks around its stressed values. */
export function segments(sentence: string): Segment[] {
    const out: Segment[] = []
    for (const part of sentence.split(OPEN)) {
        const [strong, rest] = part.includes(CLOSE) ? part.split(CLOSE) : [undefined, part]
        if (strong) out.push({ text: strong, strong: true })
        if (rest) out.push({ text: rest })
    }
    return out
}

/** A source, or several: one is named by its last name ("Photos"), several are counted. */
export function sourcesWords(paths: readonly (string | undefined)[]): string {
    const shown = paths.map((path) => path?.trim() ?? '').filter(Boolean)
    if (shown.length === 1) return stressed(buildReadablePath(shown[0], 'short'))
    const count = shown.length
    return stressed(plural(count, { one: '# item', other: '# items' }))
}

/** A destination, named in full, shortened in the middle when it is long. */
export function placeWords(path: string | undefined): string {
    return stressed(buildReadablePath(path?.trim() ?? ''))
}

export function transferLine(
    operation: OperationSubset<'copy' | 'move' | 'sync'>,
    sources: readonly (string | undefined)[],
    destination: string | undefined
): BarLine {
    const what = sourcesWords(sources)
    const place = placeWords(destination)
    switch (operation) {
        case 'copy':
            return {
                title: segments(t`Copy ${what} to ${place}`),
                detail: t`Files already there are skipped, and nothing is deleted.`,
            }
        case 'move':
            return {
                title: segments(t`Move ${what} to ${place}`),
                detail: t`Each file is removed from the source once it has arrived.`,
            }
        default: {
            const folder = buildReadablePath(destination?.trim() ?? '')
            return {
                title: segments(t`Sync ${what} to ${place}`),
                detail: t`Files that are only in ${folder} are deleted.`,
            }
        }
    }
}

export function bisyncLine(a: string | undefined, b: string | undefined): BarLine {
    const first = sourcesWords([a])
    const second = sourcesWords([b])
    return {
        title: segments(t`Bisync ${first} and ${second}`),
        detail: t`What changes on either side is copied to the other.`,
    }
}

export function deleteLine(paths: readonly string[], filtered: boolean): BarLine {
    const what = sourcesWords(paths)
    return {
        title: segments(t`Delete the files in ${what}`),
        detail: filtered
            ? t`Only the files that match the filters are deleted.`
            : t`Every file is deleted, and the folders are kept.`,
    }
}

export function purgeLine(paths: readonly string[]): BarLine {
    const many = paths.filter((path) => path.trim()).length > 1
    const what = sourcesWords(paths)
    return {
        title: segments(t`Purge ${what}`),
        detail: many
            ? t`The folders and everything in them are deleted.`
            : t`The folder and everything in it are deleted.`,
    }
}

export function mountLine(source: string | undefined, mountPoint: string): BarLine {
    const remote = placeWords(source)
    const place = placeWords(mountPoint)
    return { title: segments(t`Mount ${remote} at ${place}`) }
}

export function serveLine(source: string | undefined, protocol: string): BarLine {
    const what = sourcesWords([source])
    const over = stressed(protocol)
    return { title: segments(t`Serve ${what} over ${over}`) }
}

export function downloadLine(filename: string, destination: string | undefined): BarLine {
    const file = stressed(filename)
    const place = placeWords(destination)
    return { title: segments(t`Download ${file} to ${place}`) }
}

/** A line with no places, such as "Copy started". The caller translates its text. */
export function plainLine(title: string, detail?: string): BarLine {
    return { title: [{ text: title }], detail }
}
