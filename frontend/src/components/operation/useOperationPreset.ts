import { useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { navigate } from '../../../lib/api/navigation'
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

/**
 * What an operation page opens with: the `preset` in its URL (the job drawer's Reuse settings,
 * the Wizard's plan). Read once, on mount. `onStarted` is for the start mutation's
 * success: it keeps the template the preset asked for, from the options the page ran with.
 */
export function useOperationPreset<O extends PresetOperation>(operation: O) {
    const [searchParams] = useSearchParams()
    const read = useRef<{ preset: PresetFor<O> | undefined } | null>(null)
    if (read.current === null) {
        read.current = {
            preset: decodePreset(searchParams.get('preset'), operation),
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

/** Opens the operation's page with the preset. */
export function openOperation(preset: OperationPreset) {
    navigate(presetRoute(preset))
}
