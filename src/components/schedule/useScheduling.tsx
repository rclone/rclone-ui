import { Button } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { Operations, Schedules } from '../../../lib/core/types'
import { coreError, reportError } from '../../../lib/errors'
import { saveSchedule, useLeftOff, useSchedule } from '../../../lib/schedules'
import { message } from '../../../lib/shell'
import { usePageQuery, usePageStart, useSetPageQuery } from '../../route'
import { WINDOWS } from '../../routes'
import { IconTile } from '../look/IconTile'
import { Panel } from '../look/Panel'
import { isScheduleOperation, operationLine, singleRunLine } from './form'
import ScheduleDrawer, { DELETED, toastSaved } from './ScheduleDrawer'

function editingLine(name: string): string {
    return t`Editing the schedule ${name}`
}

/** The `?schedule=` that opens an operation page in edit mode. */
const PARAM = 'schedule'

/**
 * Scheduling on an operation page: the "Schedule" drawer, which saves the page's form as a new
 * schedule, and the edit mode that `?schedule={id}` opens ("Edit the {operation}" in the
 * Schedules list), where Start saves the form into the schedule instead. Only the six operations
 * that a schedule can run have it.
 *
 * `problem` is the page's reason not to start, and `buildForm` its form, as Start sends it.
 */
export function useScheduling({
    operation,
    enabled,
    problem,
    buildForm,
    title,
}: {
    operation: string
    /** False on pages that start something else than a transfer (Mount, Serve, Download). */
    enabled: boolean
    problem: () => string | undefined
    buildForm: () => Operations.Form
    /** The page's title, for the dialogs. */
    title: string
}) {
    const schedulable = enabled && isScheduleOperation(operation)
    const pageQuery = usePageQuery()
    const setPageQuery = useSetPageQuery()
    const start = usePageStart(operation)
    const [id, setId] = useState<string | null>(() => (schedulable ? pageQuery.get(PARAM) : null))
    const query = useSchedule(id)
    // The schedule stays as it was loaded if it is deleted meanwhile, so that Save changes can say
    // so. One that was gone already when the page opened just leaves edit mode.
    const schedule: Schedules.Schedule | null = id ? (query.data ?? null) : null
    const gone = !!id && !query.data && coreError(query.error)?.code === 'not_found'

    // Leaving edit mode removes `?schedule=` from the address. The page stays as it is, and
    // keeps its form.
    const leave = useCallback(() => {
        setId(null)
        setPageQuery({ [PARAM]: null })
    }, [setPageQuery])
    useEffect(() => {
        if (gone) leave()
    }, [gone, leave])

    const [saving, setSaving] = useState(false)
    const [drawer, setDrawer] = useState<{
        isOpen: boolean
        key: number
        form?: Operations.Form
    }>({ isOpen: false, key: 0 })

    /**
     * Opens the drawer with the page's form. The button is disabled while the page has a problem.
     */
    const openDrawer = () => {
        if (problem()) return
        setDrawer((d) => ({ isOpen: true, key: d.key + 1, form: buildForm() }))
    }

    // A preset with a time (a plan from the Wizard) opens the drawer at that time once the page
    // has opened, so that the user only names the schedule and saves it.
    const [presetWhen] = useState(() => {
        if (!schedulable || id) return undefined
        return start.preset?.when?.trim() || undefined
    })
    const openedForPreset = useRef(false)
    // biome-ignore lint/correctness/useExhaustiveDependencies: it opens once, with the form as the page opened
    useEffect(() => {
        if (!presetWhen || openedForPreset.current) return
        openedForPreset.current = true
        openDrawer()
    }, [presetWhen])

    /**
     * Saves the page's form into the schedule, keeping its name and time. The page's question and
     * retry are skipped: the drawer's lines, in the bar, say the same.
     */
    const saveChanges = async () => {
        if (!schedule || saving) return
        const reason = problem()
        if (reason) return
        setSaving(true)
        let saved: Schedules.Schedule
        try {
            saved = await saveSchedule({
                id: schedule.id,
                name: schedule.name,
                form: buildForm(),
                when: schedule.when,
            })
        } catch (failure) {
            // The button stops spinning before the dialog, as it does after a refused start.
            setSaving(false)
            if (coreError(failure)?.code === 'not_found') {
                await message(DELETED, { title, kind: 'error' })
                leave()
                return
            }
            await reportError(failure, {
                title,
                fallback: t`The schedule could not be saved.`,
                log: [`[${operation}] schedule not saved`],
            })
            return
        }
        setSaving(false)
        toastSaved(saved, t`Saved changes`)
    }

    // In edit mode, the bar says what the schedule leaves off, as the drawer does.
    const form = schedulable && id && !problem() ? buildForm() : null
    const leftOff = useLeftOff(form)

    let element: ReactNode = null
    if (schedulable && id) {
        const lines = form ? [operationLine(form), singleRunLine(leftOff)] : []
        element = (
            <Panel className="flex items-start gap-3.5 px-4 py-3.5">
                <IconTile icon={WINDOWS.schedules.icon} tone={WINDOWS.schedules.tone} size="lg" />
                <div className="flex flex-col flex-1 min-w-0 gap-1">
                    <p className="font-medium break-words">
                        {schedule ? editingLine(schedule.name) : t`Editing a schedule`}
                    </p>
                    {lines
                        .filter((line): line is string => !!line)
                        .map((line) => (
                            <p key={line} className="leading-snug text-small text-default-600">
                                {line}
                            </p>
                        ))}
                </div>
                <Button size="sm" variant="flat" className="shrink-0" onPress={leave}>
                    <Trans>Cancel</Trans>
                </Button>
            </Panel>
        )
    } else if (schedulable && drawer.form) {
        element = (
            <ScheduleDrawer
                key={drawer.key}
                isOpen={drawer.isOpen}
                onClose={() => setDrawer((d) => ({ ...d, isOpen: false }))}
                form={drawer.form}
                initialWhen={presetWhen}
            />
        )
    }

    return {
        /** Whether the page has a Schedule button. */
        schedulable: schedulable && !id,
        /** Whether Start saves the form into a schedule. */
        editing: schedulable && !!id,
        /** Whether the schedule has loaded, so that Save changes can save it. */
        ready: !!schedule,
        saving,
        openDrawer,
        saveChanges,
        /** The bar of the edit mode, or the drawer. The page shows it at the top of its form. */
        element,
    }
}
