import { plural, t } from '@lingui/core/macro'
import type { Operations } from '../../../lib/core/types'
import { message } from '../../../lib/shell'
import type { FlagValue } from '../../../types/rclone'
import type { StartAnswer } from './useOperationSubmission'

// The questions asked before a start that deletes files. The confirm functions are for any start:
// a page's, or a template's.

/**
 * A question asked before a start. `start` and `dryRun` are the labels of its buttons.
 * `destructive` draws it in red, for a start that only deletes.
 */
export interface StartQuestion {
    title?: string
    text: string
    start: string
    dryRun?: string
    destructive?: true
}

function listed(question: string, sources: readonly string[]): string {
    return `${question}\n\n${sources.join('\n')}`
}

/** Delete keeps the folders. With filters, only the files that match them are deleted. */
export function deleteQuestion(sources: readonly string[], filtered: boolean): StartQuestion {
    const one = sources.length === 1
    const [path] = sources
    const count = sources.length
    if (filtered) {
        return {
            title: t`Delete files`,
            text: one
                ? t`Permanently delete the files matching your filters in ${path}?`
                : listed(
                      plural(count, {
                          one: 'Permanently delete the files matching your filters in this # path?',
                          other: 'Permanently delete the files matching your filters in these # paths?',
                      }),
                      sources
                  ),
            start: t`Delete Matching Files`,
            destructive: true,
        }
    }
    return {
        title: t`Delete files`,
        text: one
            ? t`Delete the files at ${path}? This can't be undone.`
            : listed(
                  plural(count, {
                      one: "Delete the files at this # path? This can't be undone.",
                      other: "Delete the files at these # paths? This can't be undone.",
                  }),
                  sources
              ),
        start: t({ message: 'Delete', context: 'button that starts the operation' }),
        destructive: true,
    }
}

export function purgeQuestion(sources: readonly string[]): StartQuestion {
    const [path] = sources
    const count = sources.length
    return {
        title: t`Purge`,
        text:
            count === 1
                ? t`Purge ${path}? It is removed with everything in it, and this can't be undone.`
                : listed(
                      plural(count, {
                          one: "Purge this # path? It is removed with everything in it, and this can't be undone.",
                          other: "Purge these # paths? Each is removed with everything in it, and this can't be undone.",
                      }),
                      sources
                  ),
        start: t({ message: 'Purge', context: 'button that starts the operation' }),
        destructive: true,
    }
}

/** `switches` are the Bisync page's own (the `outer` group). A template has none. */
export function bisyncQuestion(
    a: string,
    b: string,
    switches: Readonly<Operations.BisyncSwitches> = {}
): StartQuestion {
    const lines = [
        t`Bisync ${a} and ${b}? Changes and deletions on either side are made on the other too.`,
    ]
    if (switches.resync) {
        lines.push(
            t`Resync is on. Where the two sides differ, the version in ${a} replaces the one in ${b}.`
        )
    }
    if (switches.force) {
        lines.push(
            t`Force is on. Bisync will not stop when many files are deleted or changed at a time.`
        )
    }
    return { title: t`Bisync`, text: lines.join('\n\n'), start: t`Start bisync` }
}

export async function confirmDelete(
    sources: readonly string[],
    filtered = false
): Promise<boolean> {
    return (await askBeforeStart(deleteQuestion(sources, filtered))) === 'start'
}

export async function confirmPurge(sources: readonly string[]): Promise<boolean> {
    return (await askBeforeStart(purgeQuestion(sources))) === 'start'
}

export async function confirmBisync(
    a: string,
    b: string,
    switches?: Readonly<Operations.BisyncSwitches>
): Promise<boolean> {
    return (await askBeforeStart(bisyncQuestion(a, b, switches))) === 'start'
}

export function syncQuestion(source: string, destination: string): StartQuestion {
    return {
        text: t`Files in ${destination} that aren't in ${source} will be deleted.`,
        start: t`Start sync`,
        dryRun: t`Dry run first`,
    }
}

// Options in the filter group that change how the rules are applied, but don't select files.
const NOT_RULES = new Set(['ignore_case'])

// The filter rules in the metadata group. The group's other options control which metadata is
// copied.
const METADATA_RULES = /^metadata_(include|exclude|filter)/

function isSet(value: FlagValue | undefined): boolean {
    if (value === undefined || value === null || value === false || value === '') return false
    if (value === 'off') return false
    if (Array.isArray(value)) return value.some((item) => item !== '')
    return true
}

/**
 * Whether the options limit which files an operation includes. That is the case when a filter
 * rule (a pattern, an age, a size, a list of files) or a metadata filter rule is set.
 */
export function hasFilters(
    filter: Record<string, FlagValue> = {},
    metadata: Record<string, FlagValue> = {}
): boolean {
    return (
        Object.entries(filter).some(([name, value]) => !NOT_RULES.has(name) && isSet(value)) ||
        Object.entries(metadata).some(([name, value]) => METADATA_RULES.test(name) && isSet(value))
    )
}

/**
 * Asks a question before a start. `title` replaces the question's own title. Cancelling or
 * closing the dialog answers 'cancel'.
 */
export async function askBeforeStart(
    question: StartQuestion,
    title?: string
): Promise<StartAnswer> {
    const pressed = await message(question.text, {
        title: title ?? question.title,
        kind: 'warning',
        buttons: { ok: question.start, cancel: t`Cancel`, extra: question.dryRun },
        destructive: question.destructive ?? false,
    })
    if (pressed === question.start) return 'start'
    if (question.dryRun && pressed === question.dryRun) return 'dryRun'
    return 'cancel'
}
