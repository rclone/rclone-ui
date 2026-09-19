import cronstrue from 'cronstrue'
import type { LucideIcon } from 'lucide-react'
import {
    ArrowLeftRightIcon,
    CopyIcon,
    DownloadIcon,
    FlameIcon,
    HardDriveIcon,
    MoveIcon,
    RefreshCwIcon,
    ServerIcon,
    Trash2Icon,
} from 'lucide-react'
import { buildReadablePath } from '../../../lib/format'
import type { SERVE_TYPES } from '../../../lib/rclone/constants'
import type { OperationPreset } from '../../../lib/rclone/preset'
import type { FlagValue } from '../../../types/rclone'
import type { OperationId } from '../../components/OperationGrid'
import type { AllowedKey } from '../../components/navigator/types'

// The Wizard's model, kept apart from the page: the questions, which of them a set of answers
// walks through, the operation they resolve to, and the sentence that reads the plan back.

export type Goal = 'transfer' | 'match' | 'mount' | 'share' | 'download' | 'clear'
export type ServeType = (typeof SERVE_TYPES)[number]
/** The second question's answer: an operation for the three families, a protocol for a share. */
export type Refine = 'copy' | 'move' | 'sync' | 'bisync' | 'delete' | 'purge' | ServeType
export type Metadata = 'none' | 'keep' | 'map'
export type When = 'once' | 'hourly' | 'daily' | 'weekly' | 'custom'
export type Keep = 'once' | 'template'
export type StepKey = 'goal' | 'refine' | 'places' | 'metadata' | 'when' | 'keep' | 'plan'

export interface Answers {
    goal?: Goal
    refine?: Refine
    source?: string
    destination?: string
    url?: string
    metadata?: Metadata
    /** The mapping behind `map`, as the flag's argv; only once it has a rule. */
    mapper?: string[]
    when?: When
    /** The expression behind a custom `when`. */
    cron?: string | null
    keep?: Keep
    templateName?: string
}

/**
 * The operations' colours, the ones their option accordions already wear (copy and move are
 * primary, sync success, bisync lime, mount secondary, serve cyan); the destructive pair is
 * danger and a download orange.
 */
export type Tone = 'primary' | 'success' | 'lime' | 'secondary' | 'cyan' | 'orange' | 'danger'

export const OPERATION_TONE: Record<OperationId, Tone> = {
    copy: 'primary',
    move: 'primary',
    sync: 'success',
    bisync: 'lime',
    mount: 'secondary',
    serve: 'cyan',
    download: 'orange',
    delete: 'danger',
    purge: 'danger',
}

export interface Choice<K extends string = string> {
    key: K
    title: string
    description: string
    icon?: LucideIcon
    /** The colour the card and its icon carry: the operation's, where the choice is one. */
    tone?: Tone
}

export const GOAL_QUESTION = 'What do you want to do?'

export const GOALS: Choice<Goal>[] = [
    {
        key: 'transfer',
        title: 'Copy or move files',
        description: 'Put the files from one place into another.',
        icon: CopyIcon,
        tone: 'primary',
    },
    {
        key: 'match',
        title: 'Sync or bisync',
        description: 'Keep two places the same.',
        icon: RefreshCwIcon,
        tone: 'success',
    },
    {
        key: 'mount',
        title: 'Mount as drive',
        description: 'Open a remote in your file manager, like a disk.',
        icon: HardDriveIcon,
        tone: 'secondary',
    },
    {
        key: 'share',
        title: 'Serve files over the network',
        description: 'Let other apps & devices reach a folder.',
        icon: ServerIcon,
        tone: 'cyan',
    },
    {
        key: 'download',
        title: 'Download from a link',
        description: 'Fetch a file straight into a folder or a remote.',
        icon: DownloadIcon,
        tone: 'orange',
    },
    {
        key: 'clear',
        title: 'Purge or delete',
        description: 'Delete what is in a folder, or the folder itself.',
        icon: Trash2Icon,
        tone: 'danger',
    },
]

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

// The second question, per goal. Mounts and downloads have none: the goal already names them.
const REFINE: Partial<Record<Goal, { question: string; choices: Choice<Refine>[] }>> = {
    transfer: {
        question: 'What happens to the originals?',
        choices: [
            {
                key: 'copy',
                title: 'Keep them',
                description: 'The files stay where they are; the destination gets a copy.',
                icon: CopyIcon,
                tone: OPERATION_TONE.copy,
            },
            {
                key: 'move',
                title: 'Take them away',
                description: 'The files leave the source once they have arrived.',
                icon: MoveIcon,
                tone: OPERATION_TONE.move,
            },
        ],
    },
    match: {
        question: 'Which way do changes go?',
        choices: [
            {
                key: 'sync',
                title: 'One way',
                description:
                    'The second place becomes a mirror of the first. Files only in the second place are removed.',
                icon: RefreshCwIcon,
                tone: OPERATION_TONE.sync,
            },
            {
                key: 'bisync',
                title: 'Both ways',
                description: 'Changes on either side reach the other.',
                icon: ArrowLeftRightIcon,
                tone: OPERATION_TONE.bisync,
            },
        ],
    },
    share: {
        question: 'How will others connect?',
        choices: [
            { key: 'http', title: 'In a browser', description: 'A web page listing the files.' },
            {
                key: 'webdav',
                title: 'As a network folder',
                description: 'WebDAV, which Finder, Explorer and most apps can open.',
            },
            { key: 'sftp', title: 'SFTP', description: 'For SFTP clients and command-line tools.' },
            { key: 'ftp', title: 'FTP', description: 'For FTP clients.' },
            {
                key: 's3',
                title: 'As an S3 bucket',
                description: 'For tools and apps that speak the S3 API.',
            },
            { key: 'nfs', title: 'NFS', description: 'A network file system for Unix machines.' },
            {
                key: 'dlna',
                title: 'Media players',
                description: 'DLNA, for TVs and media players on the network.',
            },
            {
                key: 'restic',
                title: 'Restic backups',
                description: 'A REST target for the restic backup tool.',
            },
        ],
    },
    clear: {
        question: 'How much goes?',
        choices: [
            {
                key: 'delete',
                title: 'Only the files',
                description: 'The folders stay, emptied.',
                icon: Trash2Icon,
                tone: OPERATION_TONE.delete,
            },
            {
                key: 'purge',
                title: 'The folder and everything in it',
                description: 'The folder itself goes too.',
                icon: FlameIcon,
                tone: OPERATION_TONE.purge,
            },
        ],
    },
}

for (const choice of REFINE.share?.choices ?? []) choice.tone = OPERATION_TONE.serve

export function refineFor(goal: Goal) {
    return REFINE[goal]
}

export function operationFor(answers: Answers): OperationId | undefined {
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

export interface PlaceField {
    key: 'source' | 'destination' | 'url'
    label: string
    kind: 'path' | 'url'
    allowedKeys?: AllowedKey[]
    /** Whether a file may be picked, not only a folder. */
    showFiles?: boolean
}

const ANY_FOLDER: PlaceField = { key: 'destination', label: 'Folder', kind: 'path' }

export function placesFor(operation: OperationId): { question: string; fields: PlaceField[] } {
    switch (operation) {
        case 'copy':
        case 'move':
            return {
                question: 'Where are the files, and where should they go?',
                fields: [
                    {
                        key: 'source',
                        label: 'Where are the files now?',
                        kind: 'path',
                        showFiles: true,
                    },
                    { key: 'destination', label: 'Where should they go?', kind: 'path' },
                ],
            }
        case 'sync':
            return {
                question: 'Which place leads, and which should follow?',
                fields: [
                    { key: 'source', label: 'Which place leads?', kind: 'path' },
                    { key: 'destination', label: 'Which place should match it?', kind: 'path' },
                ],
            }
        case 'bisync':
            return {
                question: 'Which two places?',
                fields: [
                    { key: 'source', label: 'First place', kind: 'path' },
                    { key: 'destination', label: 'Second place', kind: 'path' },
                ],
            }
        case 'mount':
            return {
                question: 'What should the drive show, and where should it appear?',
                fields: [
                    {
                        key: 'source',
                        label: 'What should the drive show?',
                        kind: 'path',
                        allowedKeys: ['REMOTES', 'FAVORITES'],
                    },
                    {
                        key: 'destination',
                        label: 'Where should it appear?',
                        kind: 'path',
                        allowedKeys: ['LOCAL_FS', 'LOCAL_FS_EXTRA'],
                    },
                ],
            }
        case 'serve':
            return {
                question: 'What should be shared?',
                fields: [{ ...ANY_FOLDER, key: 'source' }],
            }
        case 'download':
            return {
                question: 'Which link, and where should it be saved?',
                fields: [
                    { key: 'url', label: 'Which link?', kind: 'url' },
                    { key: 'destination', label: 'Where should it be saved?', kind: 'path' },
                ],
            }
        case 'delete':
        case 'purge':
            return { question: 'Which folder?', fields: [{ ...ANY_FOLDER, key: 'source' }] }
    }
}

/** Every required place is typed, and the two places are not the same one. */
export function placesComplete(answers: Answers, operation: OperationId): boolean {
    const values = placesFor(operation).fields.map((field) => answers[field.key]?.trim() ?? '')
    if (values.some((value) => value === '')) return false
    return new Set(values).size === values.length
}

export const METADATA_QUESTION = 'Should the files’ metadata come along?'

export const METADATAS: Choice<Metadata>[] = [
    { key: 'none', title: 'No', description: 'Only the files, with their modification times.' },
    {
        key: 'keep',
        title: 'Yes',
        description: 'Permissions, owners, labels: whatever the destination can hold.',
    },
    {
        key: 'map',
        title: 'Yes, with changes',
        description: 'Rename, set or drop fields on the way across.',
    },
]

/** The rules a mapping holds, for the plan: each is one `--map`, `--set` or `--drop`. */
function ruleCount(mapper: string[] | undefined): number {
    return mapper?.filter((argument) => RULE_FLAGS.has(argument)).length ?? 0
}

const RULE_FLAGS = new Set(['--map', '--set', '--drop'])

/** The metadata answer in words, for the plan's row. */
export function metadataPhrase(answers: Answers): string | undefined {
    switch (answers.metadata) {
        case 'none':
            return 'No'
        case 'keep':
            return 'Yes'
        case 'map': {
            const count = ruleCount(answers.mapper)
            return `Yes, with ${count} ${count === 1 ? 'rule' : 'rules'}`
        }
        default:
            return undefined
    }
}

/** Whether the step has what it needs to be left. */
export function stepComplete(step: StepKey, answers: Answers): boolean {
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
                !!answers.metadata &&
                (answers.metadata !== 'map' || (answers.mapper?.length ?? 0) > 0)
            )
        case 'when':
            return !!answers.when && (answers.when !== 'custom' || !!cronFor(answers))
        case 'keep':
            return !!answers.keep && (answers.keep !== 'template' || !!answers.templateName?.trim())
        case 'plan':
            return true
    }
}

/** Every step of the path is answered, so the plan can be shown and opened. */
export function planReady(answers: Answers): boolean {
    const steps = stepsFor(answers)
    return steps.includes('plan') && steps.every((step) => stepComplete(step, answers))
}

export const WHEN_QUESTION = 'When should it run?'

export const WHENS: Choice<When>[] = [
    { key: 'once', title: 'Just once', description: 'Run it now and be done.' },
    { key: 'hourly', title: 'Every hour', description: 'At the top of every hour.' },
    { key: 'daily', title: 'Every day', description: 'At 2:00 in the morning.' },
    { key: 'weekly', title: 'Every week', description: 'Sundays at 2:00 in the morning.' },
    { key: 'custom', title: 'Custom…', description: 'Pick your own times.' },
]

const WHEN_CRON: Record<Exclude<When, 'once' | 'custom'>, string> = {
    hourly: '0 * * * *',
    daily: '0 2 * * *',
    weekly: '0 2 * * 0',
}

/** The cron line the answers amount to; none for a one-off. */
export function cronFor(answers: Answers): string | null {
    switch (answers.when) {
        case 'hourly':
        case 'daily':
        case 'weekly':
            return WHEN_CRON[answers.when]
        case 'custom':
            return answers.cron?.trim() || null
        default:
            return null
    }
}

/** The schedule in words, for the sentence and the summary. */
export function whenPhrase(answers: Answers): string | undefined {
    switch (answers.when) {
        case 'once':
            return 'once'
        case 'hourly':
            return 'every hour'
        case 'daily':
            return 'every day at 2:00'
        case 'weekly':
            return 'every week on Sunday at 2:00'
        case 'custom': {
            const cron = cronFor(answers)
            if (!cron) return 'on a schedule of your own'
            try {
                const text = cronstrue.toString(cron)
                return text.charAt(0).toLowerCase() + text.slice(1)
            } catch {
                return 'on a schedule of your own'
            }
        }
        default:
            return undefined
    }
}

export const KEEP_QUESTION = 'Keep these settings for next time?'

export const KEEPS: Choice<Keep>[] = [
    { key: 'once', title: 'Just this once', description: 'Nothing is saved.' },
    {
        key: 'template',
        title: 'Save as a template',
        description: 'Reuse these settings from the operation’s Templates menu.',
    },
]

const SCHEDULABLE = new Set<OperationId>(['copy', 'move', 'sync', 'bisync', 'delete', 'purge'])
/** Where metadata moves from one place to another, so there is something to carry or map. */
const WITH_METADATA = new Set<OperationId>(['copy', 'move', 'sync', 'bisync'])

/** The path the answers take, in order. Fixed once the goal is known. */
export function stepsFor(answers: Answers): StepKey[] {
    const steps: StepKey[] = ['goal']
    if (!answers.goal) return steps
    if (refineFor(answers.goal)) steps.push('refine')
    const operation = operationFor(answers)
    if (!operation) return steps
    steps.push('places')
    // After the places: the mapping panel suggests the fields each side's backend knows.
    if (WITH_METADATA.has(operation)) steps.push('metadata')
    if (SCHEDULABLE.has(operation)) steps.push('when')
    if (operation !== 'download') steps.push('keep')
    steps.push('plan')
    return steps
}

/** How many steps the goal's path has, the same whichever way its second question goes. */
export function stepCount(goal: Goal): number {
    const refine = refineFor(goal)
    return stepsFor({ goal, refine: refine?.choices[0]?.key }).length
}

export interface Segment {
    text: string
    /** False for a blank still waiting for its answer. */
    filled: boolean
}

const fill = (text: string): Segment => ({ text, filled: true })
const blank = (label = 'somewhere'): Segment => ({ text: label, filled: false })
const place = (path: string | undefined, label?: string): Segment =>
    path?.trim() ? fill(buildReadablePath(path.trim())) : blank(label)

/** The plan read back in one sentence, blanks and all. */
export function sentence(answers: Answers): Segment[] {
    if (!answers.goal) {
        return [blank('Say what you want to do and the wizard finds the operation.')]
    }
    const operation = operationFor(answers)
    const { source, destination, url } = answers
    let body: Segment[]
    switch (operation) {
        case 'copy':
            body = [fill('Copy the files in '), place(source), fill(' to '), place(destination)]
            break
        case 'move':
            body = [fill('Move the files in '), place(source), fill(' to '), place(destination)]
            break
        case 'sync':
            body = [fill('Make '), place(destination), fill(' match '), place(source)]
            break
        case 'bisync':
            body = [
                fill('Keep '),
                place(source),
                fill(' and '),
                place(destination),
                fill(' in step'),
            ]
            break
        case 'mount':
            body = [fill('Show '), place(source), fill(' as a drive at '), place(destination)]
            break
        case 'serve':
            body = [
                fill('Share '),
                place(source),
                fill(' over '),
                fill(SERVE_LABEL[answers.refine as ServeType]),
            ]
            break
        case 'download':
            body = [
                fill('Download '),
                url?.trim() ? fill(url.trim()) : blank('a link'),
                fill(' into '),
                place(destination),
            ]
            break
        case 'delete':
            body = [fill('Delete the files in '), place(source)]
            break
        case 'purge':
            body = [fill('Remove '), place(source), fill(' and everything in it')]
            break
        default:
            // A family without its second answer yet.
            switch (answers.goal) {
                case 'transfer':
                    body = [fill('Copy or move the files in '), blank(), fill(' to '), blank()]
                    break
                case 'match':
                    body = [fill('Keep '), blank(), fill(' and '), blank(), fill(' the same')]
                    break
                case 'share':
                    body = [fill('Share '), blank(), fill(' over the network')]
                    break
                default:
                    body = [fill('Clear out '), blank()]
            }
    }
    if (answers.metadata === 'keep') body.push(fill(', metadata included'))
    if (answers.metadata === 'map') body.push(fill(', metadata mapped'))
    const when = whenPhrase(answers)
    if (when) body.push(fill(`, ${when}`))
    if (answers.keep === 'template' && answers.templateName?.trim()) {
        body.push(fill(`, keeping the settings as ‘${answers.templateName.trim()}’`))
    }
    body.push(fill('.'))
    return body
}

const compact = <T extends Record<string, unknown>>(record: T): T =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T

/**
 * The Metadata options the answer amounts to. rclone carries metadata only with `metadata` on,
 * and never runs a mapper without it, so a mapping brings both.
 */
function metadataOptions(answers: Answers): Record<string, FlagValue> | undefined {
    switch (answers.metadata) {
        case 'keep':
            return { metadata: true }
        case 'map':
            return { metadata: true, metadata_mapper: answers.mapper ?? '' }
        default:
            return undefined
    }
}

/**
 * The plan as the operation's page takes it: the places, the metadata, the schedule, the
 * template to keep. The other options stay the page's defaults.
 */
export function presetFromAnswers(answers: Answers): OperationPreset | undefined {
    const operation = operationFor(answers)
    if (!operation) return undefined
    const source = answers.source?.trim() || undefined
    const destination = answers.destination?.trim() || undefined
    const cron = cronFor(answers)
    const templateName =
        answers.keep === 'template' ? answers.templateName?.trim() || undefined : undefined
    const keep = compact({ cron: cron ?? undefined, templateName })
    const options = compact({ metadata: metadataOptions(answers) })
    switch (operation) {
        case 'copy':
        case 'move':
            return {
                operation,
                args: compact({ sources: source ? [source] : undefined, destination, options }),
                ...keep,
            }
        case 'delete':
        case 'purge':
            return {
                operation,
                args: compact({ sources: source ? [source] : undefined, options: {} }),
                ...keep,
            }
        case 'sync':
        case 'bisync':
            return { operation, args: compact({ source, destination, options }), ...keep }
        case 'mount':
            return { operation, args: compact({ source, destination, options: {} }), ...keep }
        case 'serve':
            return {
                operation,
                args: compact({ source, type: answers.refine, options: {} }),
                ...keep,
            }
        case 'download':
            return {
                operation,
                args: compact({ url: answers.url?.trim() || undefined, destination }),
            }
    }
}

// The panel under a step's options: what the step means and what the pick implies, with the
// rclone docs page for the operation once its places are being typed. Strings only; the page
// renders them. The first step has none (the cards say it all) and neither has the plan.

export interface Info {
    paragraphs: string[]
    link?: { label: string; url: string }
}

export interface InfoContext {
    /** Why schedules cannot be taken here, when they cannot (the page's `timerReason`). */
    timerReason?: string
    /** The server's OS: what a mount needs differs by it. */
    platform?: string
}

const DOCS = 'https://rclone.org'

const REFINE_INFO: Partial<Record<Goal, string[]>> = {
    transfer: [
        'Both choices put the files into the destination and skip any that are already there and unchanged. The destination is created if it is missing.',
        '"Keep them" leaves the source as it is. "Take them away" removes each file from the source once it has safely arrived.',
    ],
    match: [
        "One way changes only the second place: it gets the first place's new and changed files, and anything found only there is removed. The first place is never touched.",
        'Both ways carries changes in either direction and keeps notes between runs to tell what changed. It is the more involved of the two, so use it with care.',
    ],
    share: [
        'Every choice turns the folder into a small server on this machine; other devices connect to it over the network.',
        'A network folder is the friendliest choice: it opens in Finder or Explorer and allows changes. The others suit particular clients, players and tools.',
    ],
    clear: [
        'Only the files removes the files inside the folder and leaves the folders standing. Filters set on the Delete page narrow down which files go.',
        'The folder and everything in it removes the folder itself with all of its contents, filters or not. There is no way to undo it.',
    ],
}

// What a mount needs of the server, by its OS. Setting it up is the operator's.
const MOUNT_NEEDS: Record<string, string[]> = {
    windows: [
        'Use a free drive letter or a path that does not exist yet as the mount point.',
        'Mounting needs WinFsp installed on the server: github.com/winfsp/winfsp.',
    ],
    linux: [
        'The mount point must be an empty folder that already exists.',
        'Mounting needs FUSE on the server. A container has to be started with --device /dev/fuse --cap-add SYS_ADMIN.',
    ],
    macos: [
        'The mount point must be an empty folder that already exists.',
        'macOS needs nothing extra. Until write caching is turned on, most apps can only read from the drive.',
    ],
}

const TRANSFER_PLACES =
    'The first place can be a folder or a single file. The second is a folder, created if it does not exist yet.'

const PLACES_INFO: Record<Exclude<OperationId, 'serve'>, string[]> = {
    copy: [
        TRANSFER_PLACES,
        'Files already there and unchanged are skipped, so running it again only carries what is new. Nothing is ever removed from the destination.',
    ],
    move: [
        TRANSFER_PLACES,
        'Files already there and unchanged are skipped. Once a file has arrived it is removed from the first place; on remotes that can move files themselves, nothing is downloaded on the way.',
    ],
    sync: [
        'The place that follows is changed to match the leader: new and changed files come over, and files found only there are removed. The leader is never touched.',
        'It is the contents of the folders that are matched, not the folders themselves, and the two places must not overlap. If errors occur, nothing is removed.',
    ],
    bisync: [
        'Changes on either side are carried to the other. Between runs it keeps a record of what each place held, so it can tell what changed since.',
        'When the same file changed on both sides, both versions are kept as renamed copies. The first run needs the resync switch on the Bisync page.',
    ],
    mount: ['The drive shows a remote, or a favorite on one, in your file manager like a disk.'],
    download: [
        'The file is fetched from the link and written straight into the folder, with no temporary copy in between.',
        'For some sites the Download page can work out the direct link and suggest a file name.',
    ],
    delete: [
        'Only the files inside this folder are removed; the folders themselves stay.',
        'Filters set on the Delete page narrow down which files go.',
    ],
    purge: [
        'This folder and everything inside it is removed, filters or not.',
        'There is no undo, so check the path twice.',
    ],
}

const SERVE_NOTE: Record<ServeType, string> = {
    http: 'Visitors get a web page that lists the files.',
    webdav: 'Others can open it as a folder in Finder or Explorer and change files there.',
    sftp: 'Any SFTP client can connect. It is the more secure choice and needs a username and password, or keys.',
    ftp: 'Any FTP client can connect.',
    s3: 'Tools that speak the S3 API can use it. This one is experimental.',
    nfs: 'Unix machines can mount it; it is handy on macOS. This one is experimental.',
    dlna: 'TVs and media players on the network find it by themselves.',
    restic: 'The restic backup tool can use it as the place it backs up to.',
}

const METADATA_INFO = {
    default: [
        'Metadata is what a file carries besides its contents: permissions and owners on a disk, and on a cloud service whatever it keeps for a file, such as a description, labels or who created it. Files keep their modification time either way.',
        'Each service holds different fields, and what the destination cannot hold is left out. Carrying it can slow a transfer down, since every file’s fields are read and written too.',
    ],
    map: [
        'A rule renames one field into another, sets one to a fixed value, or drops one. Fields no rule mentions come along as they are, unless you say otherwise.',
        'Each side suggests the fields its service knows. Some services need a setting of their own before they write a field; the panel says so.',
    ],
}

const WHEN_INFO = {
    default: [
        '"Just once" means it runs when you start it, and that is all. The other choices set up a schedule the server runs, for as long as the server is up.',
        "On the Schedules page you can see each run's history and change the schedule after it is created; the runs themselves are in Transfers, like everything else.",
    ],
    custom: [
        'Write the schedule as five fields: minute, hour, day of the month, month, day of the week.',
    ],
    blocked: 'Just once still works: it runs when you start it, and that is all.',
}

const KEEP_INFO = {
    default: [
        'A template keeps these places and the options under a name, so next time you pick it instead of filling everything in again.',
        'Templates live in the operation window\'s Templates menu (the folder icon in the bottom bar) and on the Templates page. "Just this once" keeps nothing.',
    ],
    template: [
        'Give it a name you will recognize later.',
        'It is saved when the operation starts, with the places and options as they are then. Find it again in the Templates menu of the operation window, or on the Templates page.',
    ],
}

/** The rclone docs page for the operation. Labels never start with an option card's title. */
function docsFor(operation: OperationId, serveType: ServeType | undefined): Info['link'] {
    switch (operation) {
        case 'serve':
            return {
                label: `Serving over ${serveType ? SERVE_LABEL[serveType] : 'the network'} in the rclone docs`,
                url: `${DOCS}/commands/rclone_serve_${serveType ?? 'http'}/`,
            }
        case 'bisync':
            return { label: 'Bisync in the rclone docs', url: `${DOCS}/bisync/` }
        case 'download':
            return {
                label: 'Downloading from a link in the rclone docs',
                url: `${DOCS}/commands/rclone_copyurl/`,
            }
        default:
            return {
                label: `${operation.charAt(0).toUpperCase()}${operation.slice(1)} in the rclone docs`,
                url: `${DOCS}/commands/rclone_${operation}/`,
            }
    }
}

/** What the panel under the step says for these answers; nothing on the first and last steps. */
export function infoFor(step: StepKey, answers: Answers, ctx: InfoContext = {}): Info | undefined {
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
                return {
                    paragraphs: [
                        `The folder is shared over ${SERVE_LABEL[type]} from this machine. Before starting, set the address and port to listen on, on the Serve page.`,
                        SERVE_NOTE[type],
                    ],
                    link: docsFor(operation, type),
                }
            }
            const paragraphs =
                operation === 'mount'
                    ? [
                          ...PLACES_INFO.mount,
                          ...(MOUNT_NEEDS[ctx.platform ?? ''] ?? MOUNT_NEEDS.linux),
                      ]
                    : PLACES_INFO[operation]
            return { paragraphs, link: docsFor(operation, undefined) }
        }
        case 'metadata':
            return {
                paragraphs: answers.metadata === 'map' ? METADATA_INFO.map : METADATA_INFO.default,
                link: { label: 'Metadata in the rclone docs', url: `${DOCS}/docs/#metadata` },
            }
        case 'when': {
            if (ctx.timerReason) return { paragraphs: [ctx.timerReason, WHEN_INFO.blocked] }
            return { paragraphs: answers.when === 'custom' ? WHEN_INFO.custom : WHEN_INFO.default }
        }
        case 'keep':
            return {
                paragraphs: answers.keep === 'template' ? KEEP_INFO.template : KEEP_INFO.default,
            }
        default:
            return undefined
    }
}
