import { useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { openWindow } from '../../../lib/api/windows'
import {
    type OperationPreset,
    type PresetFor,
    type PresetOperation,
    decodePreset,
    presetRoute,
} from '../../../lib/rclone/preset'
import { usePersistedStore } from '../../../store/persisted'
import type { FlagValue } from '../../../types/rclone'
import type { TemplatePaths } from '../../../types/template'
import { OPERATIONS } from '../OperationGrid'

/**
 * What an operation page opens with: the `preset` in its URL (the job drawer's Reuse settings,
 * the Wizard's plan), or else the `initial*` parameters the toolbar and the Commander hand it,
 * folded into the same shape. Read once, on mount. `onStarted` is for the start mutation's
 * success: it keeps the template the preset asked for, from the options the page ran with.
 */
export function useOperationPreset<O extends PresetOperation>(operation: O) {
    const [searchParams] = useSearchParams()
    const read = useRef<{ preset: PresetFor<O> | undefined } | null>(null)
    if (read.current === null) {
        read.current = {
            preset:
                decodePreset(searchParams.get('preset'), operation) ??
                legacyPreset(operation, searchParams),
        }
    }
    const preset = read.current.preset
    const kept = useRef(false)
    const onStarted = (
        getOptions: () => Record<string, FlagValue>,
        getPaths?: () => TemplatePaths
    ) => {
        const name = preset && 'templateName' in preset ? preset.templateName?.trim() : undefined
        if (!name || kept.current || operation === 'download') return
        kept.current = true
        usePersistedStore
            .getState()
            .addTemplate(
                name,
                operation as Exclude<PresetOperation, 'download'>,
                getOptions(),
                getPaths?.()
            )
    }
    return { preset, onStarted }
}

// The parameters the pages took before presets: a source, a destination, a URL, a file name, a
// serve type. Delete and purge have no destination; one given is left out.
function legacyPreset<O extends PresetOperation>(
    operation: O,
    params: URLSearchParams
): PresetFor<O> | undefined {
    const source = params.get('initialSource') || undefined
    const destination = params.get('initialDestination') || undefined
    const url = params.get('initialUrl') || undefined
    const filename = params.get('initialFilename') || undefined
    const type = params.get('initialType') || undefined
    if (!source && !destination && !url && !filename && !type) return undefined
    let args: Record<string, unknown>
    switch (operation) {
        case 'copy':
        case 'move':
            args = { sources: source ? [source] : undefined, destination }
            break
        case 'delete':
        case 'purge':
            args = { sources: source ? [source] : undefined }
            break
        case 'download':
            args = { url, destination, filename }
            break
        case 'serve':
            args = { source, type }
            break
        default:
            args = { source, destination }
    }
    const given = Object.fromEntries(
        Object.entries(args).filter(([, value]) => value !== undefined)
    )
    return { operation, args: given } as PresetFor<O>
}

/** Opens the operation's page with the preset: a native window on the desktop, a route in a tab. */
export function openOperation(preset: OperationPreset) {
    const label =
        OPERATIONS.find((entry) => entry.id === preset.operation)?.label ?? preset.operation
    return openWindow({ name: label, url: presetRoute(preset) })
}
