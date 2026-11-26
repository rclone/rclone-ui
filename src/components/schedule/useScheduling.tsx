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

const PARAM = 'schedule'

export function useScheduling({
    operation,
    enabled,
    problem,
    buildForm,
    title,
}: {
    operation: string
    enabled: boolean
    problem: () => string | undefined
    buildForm: () => Operations.Form
    title: string
}) {
    const schedulable = enabled && isScheduleOperation(operation)
    const pageQuery = usePageQuery()
    const setPageQuery = useSetPageQuery()
    const start = usePageStart(operation)
    const [id, setId] = useState<string | null>(() => (schedulable ? pageQuery.get(PARAM) : null))
    const query = useSchedule(id)
    const schedule: Schedules.Schedule | null = id ? (query.data ?? null) : null
    const gone = !!id && !query.data && coreError(query.error)?.code === 'not_found'

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

    const openDrawer = () => {
        if (problem()) return
        setDrawer((d) => ({ isOpen: true, key: d.key + 1, form: buildForm() }))
    }

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
        schedulable: schedulable && !id,
        editing: schedulable && !!id,
        ready: !!schedule,
        saving,
        openDrawer,
        saveChanges,
        element,
    }
}
