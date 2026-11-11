import { plural, t } from '@lingui/core/macro'
import {
    Bolt as BoltIcon,
    Page as PageIcon,
    PenNib as PenNibIcon,
    TagSimple as TagSimpleIcon,
} from '@zappicon/react'
import type { Operations } from '../../../lib/core/types'
import { buildReadablePath } from '../../../lib/format'
import { formOf, type OperationSubset, operationOf } from '../../../lib/operations'
import { pathsFromArgs, savedPaths } from '../../../lib/rclone/templatePaths'
import type { Platform } from '../../../lib/shell'
import type { Template } from '../../../lib/templates'
import { presetRoute } from '../../../lib/transfers/preset'
import type { FlagValue } from '../../../types/rclone'
import type { Tone } from '../../components/look/tones'
import { type Picker, type PickerOperation, pickerFor } from '../../components/operation/places'
import { stressed as marked, segments as markedParts } from '../../components/operation/summary'
import { isScheduleOperation } from '../../components/schedule/form'
import { DEFAULT_WHEN, toCron, type WhenForm, whenInWords } from '../../components/schedule/when'
import { WINDOWS } from '../../routes'
import { protocolIcon } from '../Serve/protocols'

// The Wizard asks what the user wants to do in plain questions, one step at a time, and finds the
// operation for it. Its plan opens that operation's page with the answers filled in, where the
// user looks it over and starts it (or saves the schedule). Nothing runs from the Wizard.
//
// The questions and the plan are the windows' text, in the app's language. Each sentence of the
// plan is one message, with the places in it as values.

export type Goal = 'transfer' | 'match' | 'mount' | 'share' | 'download' | 'clear'
type ServeType = 'http' | 'webdav' | 'sftp' | 'ftp' | 's3' | 'nfs' | 'dlna' | 'restic'
export type Refine =
    | OperationSubset<'copy' | 'move' | 'sync' | 'bisync' | 'delete' | 'purge'>
    | ServeType
export type Metadata = 'none' | 'keep' | 'map'
export type When = 'once' | 'schedule'
export type Keep = 'once' | 'template'
export type StepKey = 'goal' | 'refine' | 'places' | 'metadata' | 'when' | 'keep' | 'plan'
export type Operation = PickerOperation

export interface Answers {
    goal?: Goal
    refine?: Refine
    /** One path, or several where the operation takes several (its picker's `many`). */
    sources?: string[]
    destination?: string
    url?: string
    metadata?: Metadata
    /** The `metadata_mapper` rules, as the Metadata Mapper writes them. */
    mapper?: string[]
    when?: When
    /** The time of a schedule, in the Schedule drawer's fields. */
    schedule?: WhenForm
    keep?: Keep
    templateName?: string
}

export type { Tone }

// Each operation has the look of its window (WINDOWS in src/routes.ts), so a choice that leads
// to a window looks like it.
export const OPERATION_TONE: Record<Operation, Tone> = {
    copy: WINDOWS.copy.tone,
    move: WINDOWS.move.tone,
    sync: WINDOWS.sync.tone,
    bisync: WINDOWS.bisync.tone,
    mount: WINDOWS.mount.tone,
    serve: WINDOWS.serve.tone,
    download: WINDOWS.download.tone,
    delete: WINDOWS.delete.tone,
    purge: WINDOWS.purge.tone,
}

type Icon = typeof PageIcon

export const OPERATION_ICON: Record<Operation, Icon> = {
    copy: WINDOWS.copy.icon,
    move: WINDOWS.move.icon,
    sync: WINDOWS.sync.icon,
    bisync: WINDOWS.bisync.icon,
    mount: WINDOWS.mount.icon,
    serve: WINDOWS.serve.icon,
    download: WINDOWS.download.icon,
    delete: WINDOWS.delete.icon,
    purge: WINDOWS.purge.icon,
}

export const OPERATION_LABEL: Record<Operation, string> = {
    copy: WINDOWS.copy.title,
    move: WINDOWS.move.title,
    sync: WINDOWS.sync.title,
    bisync: WINDOWS.bisync.title,
    mount: WINDOWS.mount.title,
    serve: WINDOWS.serve.title,
    download: WINDOWS.download.title,
    delete: WINDOWS.delete.title,
    purge: WINDOWS.purge.title,
}

export interface Choice<K extends string = string> {
    key: K
    title: string
    description: string
    icon?: Icon
    tone?: Tone
}

export const GOAL_QUESTION = t`What do you want to do?`

export const GOALS: Choice<Goal>[] = [
    {
        key: 'transfer',
        title: t`Copy or move files`,
        description: t`Put the files from one place into another.`,
        icon: OPERATION_ICON.copy,
        tone: OPERATION_TONE.copy,
    },
    {
        key: 'match',
        title: t`Sync or bisync`,
        description: t`Keep two places the same.`,
        icon: OPERATION_ICON.sync,
        tone: OPERATION_TONE.sync,
    },
    {
        key: 'mount',
        title: t`Mount as a drive`,
        description: t`Show a remote as a folder on this computer.`,
        icon: OPERATION_ICON.mount,
        tone: OPERATION_TONE.mount,
    },
    {
        key: 'share',
        title: t`Serve files over the network`,
        description: t`Let other apps and devices reach a folder.`,
        icon: OPERATION_ICON.serve,
        tone: OPERATION_TONE.serve,
    },
    {
        key: 'download',
        title: t`Download from a link`,
        description: t`Download a file into a local folder or remote.`,
        icon: OPERATION_ICON.download,
        tone: OPERATION_TONE.download,
    },
    {
        key: 'clear',
        title: t`Delete or purge`,
        description: t`Delete what is in a folder, or the folder itself.`,
        icon: OPERATION_ICON.delete,
        tone: OPERATION_TONE.delete,
    },
]

/** The protocols' names, which read the same in every language. */
const SERVE_LABEL: Record<ServeType, string> = {
    http: 'HTTP',
    webdav: 'WebDAV',
    sftp: 'SFTP',
    ftp: 'FTP',
    s3: 'S3',
    nfs: 'NFS',
    dlna: 'DLNA',
    restic: 'Restic',
}

const serve = (key: ServeType, title: string, description: string): Choice<Refine> => ({
    key,
    title,
    description,
    icon: protocolIcon(key),
    tone: OPERATION_TONE.serve,
})

const REFINE: Partial<Record<Goal, { question: string; choices: Choice<Refine>[] }>> = {
    transfer: {
        question: t`What happens to the originals?`,
        choices: [
            {
                key: 'copy',
                title: t`Keep them`,
                description: t`The files stay where they are, and the destination gets a copy.`,
                icon: OPERATION_ICON.copy,
                tone: OPERATION_TONE.copy,
            },
            {
                key: 'move',
                title: t`Take them away`,
                description: t`The files are removed from the source once they have arrived.`,
                icon: OPERATION_ICON.move,
                tone: OPERATION_TONE.move,
            },
        ],
    },
    match: {
        question: t`Which way do changes go?`,
        choices: [
            {
                key: 'sync',
                title: t`One way`,
                description: t`The second place becomes a copy of the first. Files only in the second place are deleted.`,
                icon: OPERATION_ICON.sync,
                tone: OPERATION_TONE.sync,
            },
            {
                key: 'bisync',
                title: t`Both ways`,
                description: t`Changes on either side reach the other.`,
                icon: OPERATION_ICON.bisync,
                tone: OPERATION_TONE.bisync,
            },
        ],
    },
    share: {
        question: t`How will others connect?`,
        choices: [
            serve('http', t`In a browser`, t`A web page that lists the files.`),
            serve(
                'webdav',
                t`As a network folder`,
                t`WebDAV, which Finder, Explorer and most apps can open.`
            ),
            serve('sftp', 'SFTP', t`For SFTP clients and command-line tools.`),
            serve('ftp', 'FTP', t`For FTP clients.`),
            serve('s3', t`As an S3 bucket`, t`For tools and apps that use the S3 API.`),
            serve('nfs', 'NFS', t`A network file system for Unix machines.`),
            serve('dlna', t`Media players`, t`DLNA, for TVs and media players on the network.`),
            serve('restic', t`Restic backups`, t`A REST server for the restic backup tool.`),
        ],
    },
    clear: {
        question: t`How much should go?`,
        choices: [
            {
                key: 'delete',
                title: t`Only the files`,
                description: t`The folders stay, emptied.`,
                icon: OPERATION_ICON.delete,
                tone: OPERATION_TONE.delete,
            },
            {
                key: 'purge',
                title: t`The folder and everything in it`,
                description: t`The folder itself goes too.`,
                icon: OPERATION_ICON.purge,
                tone: OPERATION_TONE.purge,
            },
        ],
    },
}

export function refineFor(goal: Goal) {
    return REFINE[goal]
}

export function operationFor(answers: Answers): Operation | undefined {
    switch (answers.goal) {
        case 'mount':
            return 'mount'
        case 'download':
            return 'download'
        case 'share':
            return answers.refine ? 'serve' : undefined
        case 'transfer':
        case 'match':
        case 'clear':
            return answers.refine as Exclude<Refine, ServeType> | undefined
        default:
            return undefined
    }
}

/**
 * The answers once refine is chosen. Sources that could be files are asked again when the new
 * choice takes folders only, as from Delete to Purge or from Sync to Bisync: nothing here tells a
 * file from a folder.
 */
export function withRefine(answers: Answers, refine: Refine): Answers {
    const next = { ...answers, refine }
    const before = operationFor(answers)
    const after = operationFor(next)
    if (before && after && pickerFor(before, 'source').files && !pickerFor(after, 'source').files) {
        const { sources: _, ...rest } = next
        return rest
    }
    return next
}

export interface PlaceField {
    key: 'sources' | 'destination' | 'url'
    label: string
    kind: 'path' | 'url'
    /** A path field's picker, the operation page's own. */
    picker?: Picker
}

const sourcesField = (operation: Operation, label: string): PlaceField => ({
    key: 'sources',
    label,
    kind: 'path',
    picker: pickerFor(operation, 'source'),
})

const destinationField = (operation: Operation, label: string): PlaceField => ({
    key: 'destination',
    label,
    kind: 'path',
    picker: pickerFor(operation, 'destination'),
})

export function placesFor(operation: Operation): { question: string; fields: PlaceField[] } {
    switch (operation) {
        case 'copy':
        case 'move':
            return {
                question: t`Where are the files, and where should they go?`,
                fields: [
                    sourcesField(operation, t`Where are the files now?`),
                    destinationField(operation, t`Where should they go?`),
                ],
            }
        case 'sync':
            return {
                question: t`Which place leads, and which should follow?`,
                fields: [
                    sourcesField(operation, t`Which place leads?`),
                    destinationField(operation, t`Which place should match it?`),
                ],
            }
        case 'bisync':
            return {
                question: t`Which two places?`,
                fields: [
                    sourcesField(operation, t`First place`),
                    destinationField(operation, t`Second place`),
                ],
            }
        case 'mount':
            return {
                question: t`What should the drive show, and where should it appear?`,
                fields: [
                    sourcesField(operation, t`What should the drive show?`),
                    destinationField(operation, t`Where should it appear?`),
                ],
            }
        case 'serve':
            return {
                question: t`What should be shared?`,
                fields: [sourcesField(operation, t`Folder`)],
            }
        case 'download':
            return {
                question: t`Which link, and where should it be saved?`,
                fields: [
                    { key: 'url', label: t`Which link?`, kind: 'url' },
                    destinationField(operation, t`Where should it be saved?`),
                ],
            }
        case 'delete':
            return {
                question: t`What should be deleted?`,
                fields: [sourcesField(operation, t`Files or folders`)],
            }
        case 'purge':
            return { question: t`Which folders?`, fields: [sourcesField(operation, t`Folders`)] }
    }
}

/** A field's paths as answered: trimmed, none empty. */
export function pathsOf(answers: Answers, key: PlaceField['key']): string[] {
    const values = key === 'sources' ? (answers.sources ?? []) : [answers[key] ?? '']
    return values.map((value) => value.trim()).filter(Boolean)
}

// Every field answered, and no path given twice: a source is never its own destination.
function placesComplete(answers: Answers, operation: Operation): boolean {
    const fields = placesFor(operation).fields
    if (fields.some((field) => pathsOf(answers, field.key).length === 0)) return false
    const values = fields.flatMap((field) => pathsOf(answers, field.key))
    return new Set(values).size === values.length
}

export const METADATA_QUESTION = t`Should the files’ metadata come along?`

// The short answers, which the plan's Metadata row shows too.
const NO = t({ message: 'No', comment: 'Answer to “Should the files’ metadata come along?”' })
const YES = t({ message: 'Yes', comment: 'Answer to “Should the files’ metadata come along?”' })

export const METADATAS: Choice<Metadata>[] = [
    {
        key: 'none',
        title: NO,
        description: t`Only the files, with their modification times.`,
        icon: PageIcon,
        tone: 'graphite',
    },
    {
        key: 'keep',
        title: YES,
        description: t`Whatever the destination can hold (permissions, owners, labels, etc.).`,
        icon: TagSimpleIcon,
        tone: 'indigo',
    },
    {
        key: 'map',
        title: t`Yes, with changes`,
        description: t`Rename, set or drop fields on the way across.`,
        icon: PenNibIcon,
        tone: 'indigo',
    },
]

const RULE_FLAGS = new Set(['--map', '--set', '--drop'])

function ruleCount(mapper: string[] | undefined): number {
    return mapper?.filter((argument) => RULE_FLAGS.has(argument)).length ?? 0
}

export function metadataPhrase(answers: Answers): string | undefined {
    switch (answers.metadata) {
        case 'none':
            return NO
        case 'keep':
            return YES
        case 'map':
            return plural(ruleCount(answers.mapper), {
                one: 'Yes, with # rule',
                other: 'Yes, with # rules',
            })
        default:
            return undefined
    }
}

export const WHEN_QUESTION = t`When should it run?`

export const WHENS: Choice<When>[] = [
    {
        key: 'once',
        title: t`Just once`,
        description: t`You start it yourself.`,
        icon: BoltIcon,
        tone: 'graphite',
    },
    {
        key: 'schedule',
        title: t`On a schedule`,
        description: t`It runs at set times while Rclone UI is open or in the background.`,
        icon: WINDOWS.schedules.icon,
        tone: WINDOWS.schedules.tone,
    },
]

/** The schedule's cron expression, or undefined when it runs once or has no time yet. */
export function cronFor(answers: Answers): string | undefined {
    if (answers.when !== 'schedule') return undefined
    return toCron(answers.schedule ?? DEFAULT_WHEN) || undefined
}

/**
 * When it runs, as the plan's When row says it: "Just once", or a schedule's time as the
 * Schedules window says it ("Every day at 02:00").
 */
export function whenPhrase(answers: Answers): string | undefined {
    if (answers.when === 'once') return t`Just once`
    if (answers.when !== 'schedule') return undefined
    const cron = cronFor(answers)
    if (!cron) return t`On a schedule`
    return whenInWords(cron) ?? t`On the schedule ${cron}`
}

export const KEEP_QUESTION = t`Keep these settings for next time?`

export const KEEPS: Choice<Keep>[] = [
    {
        key: 'once',
        title: t`Just this once`,
        description: t`Nothing is saved.`,
        icon: BoltIcon,
        tone: 'graphite',
    },
    {
        key: 'template',
        title: t`Save as a template`,
        description: t`Pick them again from the operation’s Templates menu.`,
        icon: WINDOWS.templates.icon,
        tone: WINDOWS.templates.tone,
    },
]

const WITH_METADATA = new Set<Operation>(['copy', 'move', 'sync', 'bisync'])

export function stepsFor(answers: Answers): StepKey[] {
    const steps: StepKey[] = ['goal']
    if (!answers.goal) return steps
    if (refineFor(answers.goal)) steps.push('refine')
    const operation = operationFor(answers)
    if (!operation) return steps
    steps.push('places')
    if (WITH_METADATA.has(operation)) steps.push('metadata')
    if (isScheduleOperation(operation)) steps.push('when')
    if (operation !== 'download') steps.push('keep')
    steps.push('plan')
    return steps
}

/** How many steps a goal takes, counted with its first choice. */
export function stepCount(goal: Goal): number {
    const refine = refineFor(goal)
    return stepsFor({ goal, refine: refine?.choices[0]?.key }).length
}

/**
 * Whether a step is answered. `problem` is what the core says is wrong with the schedule's time,
 * if anything. While it is set, the When step isn't answered.
 */
export function stepComplete(step: StepKey, answers: Answers, problem?: string): boolean {
    switch (step) {
        case 'goal':
            return !!answers.goal
        case 'refine':
            return !!answers.refine
        case 'places': {
            const operation = operationFor(answers)
            return !!operation && placesComplete(answers, operation)
        }
        case 'metadata':
            // "Yes, with changes" without a rule is "Yes": the step waits for one.
            return (
                !!answers.metadata && (answers.metadata !== 'map' || ruleCount(answers.mapper) > 0)
            )
        case 'when':
            return !!answers.when && (answers.when === 'once' || (!!cronFor(answers) && !problem))
        case 'keep':
            return !!answers.keep && (answers.keep !== 'template' || !!answers.templateName?.trim())
        case 'plan':
            return true
    }
}

export interface Segment {
    text: string
    filled: boolean
}

// The plan's sentences are messages with the places in them as values. A place that isn't
// answered yet is a blank: it is marked in the message (`marked`, as the action bar stresses its
// places), and shows dimmed and underlined.

const blank = (label: string) => marked(label)

const unpicked = () =>
    blank(
        t({
            message: 'somewhere',
            comment: 'Stands in the plan for a place that the user has not picked yet.',
        })
    )

const place = (path: string | undefined) =>
    path?.trim() ? buildReadablePath(path.trim()) : unpicked()

/** Several paths are named by the first, and how many more. */
export function placesPhrase(paths: readonly string[]): string | undefined {
    const shown = paths.map((path) => path.trim()).filter(Boolean)
    if (shown.length === 0) return undefined
    const first = buildReadablePath(shown[0])
    if (shown.length === 1) return first
    const more = shown.length - 1
    return plural(more, { one: `${first} and # more`, other: `${first} and # more` })
}

const places = (paths: string[] | undefined) => placesPhrase(paths ?? []) ?? unpicked()

/** The plan's first sentence: what the operation does, and where. */
function whatSentence(answers: Answers): string {
    const operation = operationFor(answers)
    const sources = places(answers.sources)
    const source = place(answers.sources?.[0])
    const destination = place(answers.destination)
    switch (operation) {
        case 'copy':
            return t`Copy the files in ${sources} to ${destination}.`
        case 'move':
            return t`Move the files in ${sources} to ${destination}.`
        case 'sync':
            return t`Make ${destination} match ${source}.`
        case 'bisync':
            return t`Keep ${source} and ${destination} in sync.`
        case 'mount':
            return t`Mount ${source} as a drive at ${destination}.`
        case 'serve': {
            const protocol = SERVE_LABEL[answers.refine as ServeType]
            return t`Share ${source} over ${protocol}.`
        }
        case 'download': {
            const link = answers.url?.trim() || blank(t`a link`)
            return t`Download ${link} into ${destination}.`
        }
        case 'delete':
            return t`Delete the files in ${sources}.`
        case 'purge': {
            // "it" or "them", as the places are one folder or several.
            const count = Math.max(1, pathsOf(answers, 'sources').length)
            return plural(count, {
                one: `Delete ${sources} and everything in it.`,
                other: `Delete ${sources} and everything in them.`,
            })
        }
    }
    const somewhere = unpicked()
    switch (answers.goal) {
        case 'transfer':
            return t`Copy or move the files in ${somewhere} to ${somewhere}.`
        case 'match':
            return t`Keep ${somewhere} and ${somewhere} the same.`
        case 'share':
            return t`Share ${somewhere} over the network.`
        default:
            return t`Clear out ${somewhere}.`
    }
}

/** The plan as sentences that fill in as the user answers. */
export function sentence(answers: Answers): Segment[] {
    if (!answers.goal) {
        const hint = t`Pick what you want to do, and the Wizard finds the operation for it.`
        return [{ text: hint, filled: false }]
    }
    const sentences = [whatSentence(answers)]
    if (answers.metadata === 'keep') sentences.push(t`Metadata included.`)
    if (answers.metadata === 'map') sentences.push(t`Metadata mapped.`)
    const when = whenPhrase(answers)
    if (when) {
        sentences.push(
            t({
                message: `${when}.`,
                comment:
                    'When the plan runs, as a sentence of the plan: “Just once.” or a schedule’s time, such as “Every day at 02:00.”',
            })
        )
    }
    const name = answers.keep === 'template' ? answers.templateName?.trim() : undefined
    if (name) sentences.push(t`Settings kept as the template ‘${name}’.`)
    const plan = sentences.reduce((first, next) =>
        t({
            message: `${first} ${next}`,
            comment:
                'Two sentences of the plan, one after the other. Leave out the space if your language writes sentences without one.',
        })
    )
    return markedParts(plan).map(({ text, strong }) => ({ text, filled: !strong }))
}

/** The metadata options, flat, as rclone names them. */
function metadataOptions(answers: Answers): Record<string, FlagValue> | undefined {
    switch (answers.metadata) {
        case 'keep':
            return { metadata: true }
        case 'map':
            return { metadata: true, metadata_mapper: answers.mapper ?? [] }
        default:
            return undefined
    }
}

/**
 * The route that the plan opens: the operation's page with the answers filled in. The transfer
 * pages take a preset (with the schedule's time, which opens their Schedule drawer). Mount,
 * Serve and Download take their paths in the query, as the launcher sends them.
 */
export function routeFor(answers: Answers): string | undefined {
    const operation = operationFor(answers)
    if (!operation) return undefined
    const sources = pathsOf(answers, 'sources')
    const destination = answers.destination?.trim() ?? ''
    const query = (params: Record<string, string>) =>
        `/${operation}?${new URLSearchParams(params).toString()}`
    switch (operation) {
        case 'mount':
            return query({ initialSource: sources[0] ?? '', initialDestination: destination })
        case 'serve':
            return query({ initialSource: sources[0] ?? '', initialType: answers.refine ?? '' })
        case 'download':
            return query({ initialUrl: answers.url?.trim() ?? '', initialDestination: destination })
    }
    const metadata = metadataOptions(answers)
    const args: Partial<Operations.CopyArgs & Operations.SyncArgs> = {}
    if (operation === 'sync' || operation === 'bisync') {
        args.source = sources[0]
        args.destination = destination
    } else {
        args.sources = sources
        if (operation === 'copy' || operation === 'move') args.destination = destination
    }
    if (metadata) args.options = { metadata }
    const when = cronFor(answers)
    return presetRoute({ ...formOf(operation, args), ...(when ? { when } : {}) })
}

/** The template that the plan saves, without its id, or undefined when it saves none. */
export function templateFor(answers: Answers): Omit<Template, 'id'> | undefined {
    const operation = operationFor(answers)
    const name = answers.keep === 'template' ? answers.templateName?.trim() : undefined
    if (!operation || operation === 'download' || !name) return undefined
    const sources = pathsOf(answers, 'sources')
    const destination =
        operation === 'serve' || operation === 'delete' || operation === 'purge'
            ? undefined
            : answers.destination?.trim()
    return {
        name,
        tags: [operationOf(operation)],
        options: metadataOptions(answers) ?? {},
        paths: savedPaths(pathsFromArgs({ sources, destination })),
    }
}

export interface Info {
    paragraphs: string[]
    link?: { label: string; url: string }
}

const DOCS = 'https://rclone.org'

const REFINE_INFO: Partial<Record<Goal, string[]>> = {
    transfer: [
        t`Both choices put the files into the destination, and skip any that are already there and unchanged. The destination is created if it is missing.`,
        t`"Keep them" leaves the source as it is. "Take them away" removes each file from the source once it has safely arrived.`,
    ],
    match: [
        t`One way changes only the second place: it gets the first place's new and changed files, and anything found only there is deleted. The first place is never touched.`,
        t`Both ways carries changes in either direction, and keeps notes between runs to tell what changed. It is the more involved of the two, so use it with care.`,
    ],
    share: [
        t`Every choice turns the folder into a small server on this computer, which other devices connect to over the network.`,
        t`A network folder is the easiest choice: it opens in Finder or Explorer and allows changes. The others suit particular clients, players and tools.`,
    ],
    clear: [
        t`"Only the files" deletes the files inside the folder and leaves the folders. Filters set on the Delete page narrow down which files go.`,
        t`"The folder and everything in it" deletes the folder itself with everything in it, whatever the filters. It cannot be undone.`,
    ],
}

const MOUNT_NEEDS: Record<Platform, string> = {
    windows: t`Mounting on Windows needs WinFsp. The Mount page offers to install it if it is missing.`,
    linux: t`Mounting on Linux needs FUSE.`,
    macos: t`macOS needs nothing extra to mount.`,
}

const TRANSFER_PLACES = t`Pick one or more folders or single files. Where they go is a folder, which is created if it does not exist yet.`

const PLACES_INFO: Record<Exclude<Operation, 'serve' | 'mount'>, string[]> = {
    copy: [
        TRANSFER_PLACES,
        t`Files already there and unchanged are skipped, so running it again only carries what is new. Nothing is ever deleted from the destination.`,
    ],
    move: [
        TRANSFER_PLACES,
        t`Files already there and unchanged are skipped. Once a file has arrived, it is removed from the first place. Remotes that can move files themselves do it without downloading them.`,
    ],
    sync: [
        t`The place that follows is changed to match the leader: new and changed files come over, and files found only there are deleted. The leader is never touched.`,
        t`It is the contents of the folders that are matched, not the folders themselves, and the two places must not overlap. If errors occur, nothing is deleted.`,
    ],
    bisync: [
        t`Changes on either side are carried to the other. Between runs it keeps a record of what each place held, so it can tell what changed since.`,
        t`When the same file changed on both sides, both versions are kept as renamed copies. The first run compares the two places in full, which the Bisync page offers to do.`,
    ],
    download: [
        t`The file is fetched from the link and written straight into the folder.`,
        t`For some sites, the Download page can work out the direct link and suggest a file name.`,
    ],
    delete: [
        t`A file is deleted. From a folder, only the files inside are deleted, and the folders stay.`,
        t`Filters set on the Delete page narrow down which files go.`,
    ],
    purge: [
        t`Each folder and everything inside it is deleted, whatever the filters.`,
        t`It cannot be undone, so check the path twice.`,
    ],
}

const SERVE_NOTE: Record<ServeType, string> = {
    http: t`Visitors get a web page that lists the files.`,
    webdav: t`Others can open it as a folder in Finder or Explorer and change files there.`,
    sftp: t`Any SFTP client can connect. It is the more secure choice, and needs a username and password, or keys.`,
    ftp: t`Any FTP client can connect.`,
    s3: t`Tools that use the S3 API can connect to it.`,
    nfs: t`Unix machines can mount it, which is handy on macOS.`,
    dlna: t`TVs and media players on the network find it by themselves.`,
    restic: t`The restic backup tool can use it as the place it backs up to.`,
}

const METADATA_INFO = {
    default: [
        t`Metadata is what a file carries besides its contents: permissions and owners on a disk, and on a cloud service whatever it keeps for a file, such as a description, labels or who created it. Files keep their modification time either way.`,
        t`Each service holds different fields, and what the destination cannot hold is left out. Carrying metadata can slow a transfer down, because every file’s fields are read and written too.`,
    ],
    map: [
        t`A rule renames one field into another, sets one to a fixed value, or drops one. Fields that no rule mentions come along as they are, unless you say otherwise.`,
        t`Each side suggests the fields its service knows. Some services need a setting of their own before they write a field, and the panel says so.`,
    ],
}

const WHEN_INFO = {
    once: [
        t`"Just once" means it runs when you start it, and that is all.`,
        t`A schedule runs it at the times you pick, for as long as Rclone UI is open. A time missed while it was closed runs once when it opens again.`,
    ],
    schedule: [
        t`The schedule is created on the operation page, where you can also give it a name. The Schedules window lists it with its next runs and History lists each run.`,
    ],
}

const KEEP_INFO = {
    default: [
        t`A template keeps these places and options under a name, so that next time you pick it instead of filling everything in again.`,
        t`Templates are in the Templates menu at the top right of the operation’s window, and in the Templates window. "Just this once" keeps nothing.`,
    ],
    template: [
        t`Give it a name you will recognize later.`,
        t`It is saved when you open the operation page from the plan. Find it again in the Templates menu of that page, or in the Templates window.`,
    ],
}

/**
 * The label of the link to each operation's page in rclone's docs. Serve's label names its
 * protocol, so `docsFor` builds it. Download has no link: it is the app's own, more than rclone's
 * copyurl.
 */
const DOCS_LABEL: Record<Exclude<Operation, 'serve' | 'download'>, string> = {
    copy: t`Copy in the rclone docs`,
    move: t`Move in the rclone docs`,
    sync: t`Sync in the rclone docs`,
    bisync: t`Bisync in the rclone docs`,
    mount: t`Mount in the rclone docs`,
    delete: t`Delete in the rclone docs`,
    purge: t`Purge in the rclone docs`,
}

function docsFor(operation: Operation, serveType: ServeType | undefined): Info['link'] {
    switch (operation) {
        case 'serve': {
            const url = `${DOCS}/commands/rclone_serve_${serveType ?? 'http'}/`
            if (!serveType) return { label: t`Serving over the network in the rclone docs`, url }
            const protocol = SERVE_LABEL[serveType]
            return { label: t`Serving over ${protocol} in the rclone docs`, url }
        }
        case 'bisync':
            return { label: DOCS_LABEL.bisync, url: `${DOCS}/bisync/` }
        case 'download':
            return undefined
        default:
            return { label: DOCS_LABEL[operation], url: `${DOCS}/commands/rclone_${operation}/` }
    }
}

/** The "About this step" panel of a step, or undefined for a step without one. */
export function infoFor(step: StepKey, answers: Answers, os: Platform): Info | undefined {
    switch (step) {
        case 'refine': {
            const paragraphs = answers.goal && REFINE_INFO[answers.goal]
            return paragraphs ? { paragraphs } : undefined
        }
        case 'places': {
            const operation = operationFor(answers)
            if (!operation) return undefined
            if (operation === 'serve') {
                const type = answers.refine as ServeType
                const protocol = SERVE_LABEL[type]
                return {
                    paragraphs: [
                        t`The folder is shared over ${protocol} from this computer. The Serve page sets the address and port it listens on.`,
                        SERVE_NOTE[type],
                    ],
                    link: docsFor(operation, type),
                }
            }
            if (operation === 'mount') {
                return {
                    paragraphs: [
                        t`The drive shows a remote, or a folder in one, in your file manager like a disk.`,
                        MOUNT_NEEDS[os],
                    ],
                    link: docsFor(operation, undefined),
                }
            }
            return { paragraphs: PLACES_INFO[operation], link: docsFor(operation, undefined) }
        }
        case 'metadata':
            return {
                paragraphs: answers.metadata === 'map' ? METADATA_INFO.map : METADATA_INFO.default,
                link: { label: t`Metadata in the rclone docs`, url: `${DOCS}/docs/#metadata` },
            }
        case 'when':
            return {
                paragraphs: answers.when === 'schedule' ? WHEN_INFO.schedule : WHEN_INFO.once,
            }
        case 'keep':
            return {
                paragraphs: answers.keep === 'template' ? KEEP_INFO.template : KEEP_INFO.default,
            }
        case 'plan':
            return planInfo(answers)
        default:
            return undefined
    }
}

function planInfo(answers: Answers): Info | undefined {
    const operation = operationFor(answers)
    if (!operation) return undefined
    const paragraphs = [
        cronFor(answers)
            ? t`The operation’s page opens with all of this filled in, and its Schedule panel set to run it at the time you picked. Name the schedule and create it there. Nothing runs before then.`
            : t`The operation’s page opens with all of this filled in, and nothing runs yet. Look it over, change anything you like, then start it there.`,
    ]
    if (operation === 'serve') {
        paragraphs.push(t`Set the address and port to listen on before you start.`)
    }
    const name = templateFor(answers)?.name
    if (name) {
        paragraphs.push(
            t`The template ‘${name}’ is saved as the page opens, with these places and options.`
        )
    }
    return { paragraphs }
}
