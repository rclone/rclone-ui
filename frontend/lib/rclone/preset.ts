import type { FlagValue } from '../../types/rclone'
import type { BisyncArgs, CopyArgs, DeleteArgs, MoveArgs, PurgeArgs, SyncArgs } from './requests'

// Everything an operation page can open with: the paths, every option group, the remote
// overrides, the schedule and a template to keep. It travels in the page's URL (`?preset=`),
// put there by the job drawer's Reuse settings and by the Wizard's plan. Pure: no HTTP, no
// store, so the node-side spec runs it as it is.

export interface MountArgs {
    source: string
    destination: string
    options: {
        mount?: Record<string, FlagValue>
        vfs?: Record<string, FlagValue>
        filter?: Record<string, FlagValue>
        config?: Record<string, FlagValue>
        metadata?: Record<string, FlagValue>
        remotes?: Record<string, Record<string, FlagValue>>
    }
}

export interface ServeArgs {
    source: string
    type: string
    options: {
        serve?: Record<string, FlagValue>
        vfs?: Record<string, FlagValue>
        filter?: Record<string, FlagValue>
        config?: Record<string, FlagValue>
        metadata?: Record<string, FlagValue>
    }
}

export interface DownloadArgs {
    url: string
    destination: string
    filename: string
}

interface Keep {
    /** A schedule to start with; the page's Schedule section takes it. */
    cron?: string | null
    /** A template to save under this name, from the options the page starts with. */
    templateName?: string
}

/** Every field of the args is optional: a preset may carry a source alone (the toolbar's). */
export type OperationPreset =
    | ({ operation: 'copy'; args: Partial<CopyArgs> } & Keep)
    | ({ operation: 'move'; args: Partial<MoveArgs> } & Keep)
    | ({ operation: 'sync'; args: Partial<SyncArgs> } & Keep)
    | ({ operation: 'bisync'; args: Partial<BisyncArgs> } & Keep)
    | ({ operation: 'delete'; args: Partial<DeleteArgs> } & Keep)
    | ({ operation: 'purge'; args: Partial<PurgeArgs> } & Keep)
    | ({ operation: 'mount'; args: Partial<MountArgs> } & Pick<Keep, 'templateName'>)
    | ({ operation: 'serve'; args: Partial<ServeArgs> } & Pick<Keep, 'templateName'>)
    | { operation: 'download'; args: Partial<DownloadArgs> }

export type PresetOperation = OperationPreset['operation']
export type PresetFor<O extends PresetOperation> = Extract<OperationPreset, { operation: O }>

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const RE_PLUS = /\+/g
const RE_SLASH = /\//g
const RE_PADDING = /=+$/
const RE_DASH = /-/g
const RE_UNDERSCORE = /_/g

/** Base64url of the JSON: alphanumeric, so a query string and the desktop's percent-encoded boot redirect leave it small. */
export function encodePreset(preset: OperationPreset): string {
    const bytes = new TextEncoder().encode(JSON.stringify(preset))
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
    return btoa(binary).replace(RE_PLUS, '-').replace(RE_SLASH, '_').replace(RE_PADDING, '')
}

/** The preset for this operation, or nothing: a broken value or another operation's plan is ignored. */
export function decodePreset<O extends PresetOperation>(
    raw: string | null | undefined,
    operation: O
): PresetFor<O> | undefined {
    if (!raw) return undefined
    try {
        const base64 = raw.replace(RE_DASH, '+').replace(RE_UNDERSCORE, '/')
        const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
        if (!isRecord(value) || value.operation !== operation || !isRecord(value.args)) {
            return undefined
        }
        return value as unknown as PresetFor<O>
    } catch {
        return undefined
    }
}

export function presetRoute(preset: OperationPreset): string {
    return `/${preset.operation}?preset=${encodePreset(preset)}`
}
