import { Page as PageIcon } from '@zappicon/react'
import type { Operations } from '../../../lib/core/types'
import { encodePreset } from '../../../lib/transfers/preset'
import { WINDOWS } from '../../routes'
import type { Tone } from '../look/tones'
import { isScheduleOperation, type ScheduleOperation, scheduleOperation } from './form'

export const OPERATION_ICONS: Record<ScheduleOperation, typeof PageIcon> = {
    copy: WINDOWS.copy.icon,
    move: WINDOWS.move.icon,
    sync: WINDOWS.sync.icon,
    bisync: WINDOWS.bisync.icon,
    delete: WINDOWS.delete.icon,
    purge: WINDOWS.purge.icon,
}

export function operationIcon(operation: string): typeof PageIcon {
    return isScheduleOperation(operation) ? OPERATION_ICONS[operation] : PageIcon
}

export function operationTone(operation: string): Tone {
    return isScheduleOperation(operation) ? WINDOWS[operation].tone : 'blue'
}

/**
 * The route that opens a schedule's operation page in edit mode. The page opens with the
 * schedule's form, and `?schedule=` makes its Start save the schedule instead.
 */
export function editRoute(schedule: { id: string; form: Operations.Form }) {
    const preset = encodePreset(schedule.form)
    return `/${scheduleOperation(schedule.form)}?preset=${preset}&schedule=${encodeURIComponent(schedule.id)}`
}
