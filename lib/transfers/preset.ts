import type { Operations } from '../core/types'
import { openWindow } from '../shell'

// A preset lets an operation page open with a transfer's arguments already filled in, as
// "Duplicate" does. The preset is sent as base64url JSON in the page's URL (`?preset=`), and the
// page reads it once, on mount.

/**
 * An operation's form (core/operations): the operation, and its arguments in the field of that
 * operation. Each page reads its own field (argsOf in lib/operations).
 */
export type OperationPreset = Operations.Form & {
    /**
     * A time to schedule the form at, as a cron expression (from the Wizard). The page opens with
     * its Schedule drawer open at that time. Only the operations that a schedule can run read it.
     */
    when?: string
}

const RE_PLUS = /\+/g
const RE_SLASH = /\//g
const RE_PADDING = /=+$/
const RE_DASH = /-/g
const RE_UNDERSCORE = /_/g

/** Encodes the preset as base64url JSON, which is safe to put in a query string as is. */
export function encodePreset(preset: OperationPreset): string {
    const bytes = new TextEncoder().encode(JSON.stringify(preset))
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
    return btoa(binary).replace(RE_PLUS, '-').replace(RE_SLASH, '_').replace(RE_PADDING, '')
}

/** Decodes a URL's `?preset=` value. Returns undefined when it is missing or can't be read. */
export function decodePreset(encoded: string | null): OperationPreset | undefined {
    if (!encoded) return undefined
    try {
        const base64 = encoded.replace(RE_DASH, '+').replace(RE_UNDERSCORE, '/')
        const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
        const preset = JSON.parse(new TextDecoder().decode(bytes)) as OperationPreset
        return preset && typeof preset.operation === 'string' ? preset : undefined
    } catch {
        return undefined
    }
}

export function presetRoute(preset: OperationPreset): string {
    return `/${preset.operation}?preset=${encodePreset(preset)}`
}

export async function openOperation(preset: OperationPreset): Promise<void> {
    await openWindow(presetRoute(preset))
}
