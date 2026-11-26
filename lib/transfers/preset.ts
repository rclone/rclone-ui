import type { Operations } from '../core/types'
import { openWindow } from '../shell'

export type OperationPreset = Operations.Form & {
    when?: string
}

const RE_PLUS = /\+/g
const RE_SLASH = /\//g
const RE_PADDING = /=+$/
const RE_DASH = /-/g
const RE_UNDERSCORE = /_/g

export function encodePreset(preset: OperationPreset): string {
    const bytes = new TextEncoder().encode(JSON.stringify(preset))
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
    return btoa(binary).replace(RE_PLUS, '-').replace(RE_SLASH, '_').replace(RE_PADDING, '')
}

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
