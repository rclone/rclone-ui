import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Plus as PlusIcon } from '@zappicon/react'
import type { Schedules as Core } from '../../../lib/core/types'
import { reportError } from '../../../lib/errors'
import { useNow } from '../../../lib/format'
import {
    deleteSchedule,
    duplicateSchedule,
    mergeScheduleAgain,
    runScheduleNow,
    setSchedulePaused,
    useSchedules,
} from '../../../lib/schedules'
import { ask, openWindow, platform } from '../../../lib/shell'
import { ListWindow } from '../../components/list/ListWindow'
import { useDrawer } from '../../components/list/list'
import { toneButton } from '../../components/look/buttons'
import { IconTile } from '../../components/look/IconTile'
import StartAtLoginNotice from '../../components/StartAtLoginNotice'
import { OPERATION_LABELS, SCHEDULE_OPERATIONS } from '../../components/schedule/form'
import { editRoute } from '../../components/schedule/operations'
import ScheduleDrawer from '../../components/schedule/ScheduleDrawer'
import { toastSuccess } from '../../components/toast'
import { WINDOWS } from '../../routes'
import ScheduleRow, { type RowActions } from './ScheduleRow'
import { deleteQuestion, mergeQuestion, runQuestion, searchFields, summaryOf } from './status'

type Schedule = Core.Schedule

const LOOK = WINDOWS.schedules

/**
 * The Schedules window. A schedule runs an operation's form at set times, while the app runs.
 * Schedules are created on the operation pages (and from templates), so "New schedule" asks which
 * operation and opens its page. The list follows the core's schedules.changed events.
 */
export default function Schedules() {
    const query = useSchedules()
    const now = useNow()
    // The drawer edits a schedule's name and time.
    const { drawer, open, close } = useDrawer<Schedule>()

    const editing = drawer.item
    return (
        <ListWindow
            look={LOOK}
            query={query}
            fields={searchFields}
            summary={
                summaryOf(query.data ?? [], now) ||
                t`Run a copy, a sync or another operation at set times.`
            }
            action={<NewSchedule />}
            empty={{
                title: t`No schedules yet`,
                description: t`A schedule runs a copy, sync or other operation at set times, for example every night.`,
                steps: STEPS,
            }}
            notice={<StartAtLoginNotice what="Schedules" />}
            noMatch={(search) => t`No schedule is named like “${search}”.`}
            row={(s) => (
                <ScheduleRow schedule={s} now={now} actions={rowActions(s, () => open(s))} />
            )}
            drawers={
                editing ? (
                    <ScheduleDrawer
                        key={drawer.key}
                        isOpen={drawer.isOpen}
                        onClose={close}
                        schedule={editing}
                        form={editing.form}
                        onEditOperation={() => editOperation(editing)}
                    />
                ) : null
            }
        />
    )
}

const STEPS = [
    t`Open Copy, Sync or another operation, and fill it in.`,
    t`Press Schedule, and pick the days and the time.`,
    t`It runs at those times. Each run shows in History.`,
]

function NewSchedule() {
    return (
        <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
            <DropdownTrigger>
                <Button
                    color="primary"
                    className={toneButton(LOOK.tone)}
                    startContent={<PlusIcon className="size-4" />}
                >
                    <Trans>New schedule</Trans>
                </Button>
            </DropdownTrigger>
            <DropdownMenu
                aria-label={t`Which operation to schedule`}
                onAction={(key) => openWindow(`/${String(key)}`)}
            >
                {SCHEDULE_OPERATIONS.map((operation) => {
                    const look = WINDOWS[operation]
                    return (
                        <DropdownItem
                            key={operation}
                            startContent={<IconTile icon={look.icon} tone={look.tone} size="sm" />}
                        >
                            {OPERATION_LABELS[operation]}
                        </DropdownItem>
                    )
                })}
            </DropdownMenu>
        </Dropdown>
    )
}

function editOperation(s: Schedule) {
    openWindow(editRoute(s)).catch((error: unknown) =>
        reportError(error, { title: t`Page not opened`, log: ['[Schedules] Page not opened'] })
    )
}

/** `title` is for the error dialog. `log` says in English what failed, for the log. */
async function call(fn: () => Promise<unknown>, title: string, log: string) {
    try {
        await fn()
        return true
    } catch (error) {
        await reportError(error, { title, log: [`[Schedules] ${log}`] })
        return false
    }
}

function rowActions(s: Schedule, onEdit: () => void): RowActions {
    const name = s.name
    return {
        onPause: (paused) =>
            paused
                ? call(() => setSchedulePaused(s.id, true), t`Schedule not paused`, 'not paused')
                : call(
                      () => setSchedulePaused(s.id, false),
                      t`Schedule not resumed`,
                      'not resumed'
                  ),
        onRunNow: async () => {
            const question = runQuestion(s)
            const sure = await ask(question.text, {
                title: t`Run ${name}`,
                kind: question.warning ? 'warning' : 'info',
                // The warning is about the files that the run deletes.
                destructive: question.warning,
                okLabel: t`Run now`,
                cancelLabel: t`Cancel`,
            })
            if (sure) await call(() => runScheduleNow(s.id), t`Schedule not run`, 'not run')
        },
        onEdit,
        onEditOperation: () => editOperation(s),
        onMerge: async () => {
            const sure = await ask(mergeQuestion(s), {
                title: t`Merge ${name}`,
                okLabel: t({
                    message: 'Merge',
                    comment: 'Button: merges the two folders of a bisync again.',
                }),
                cancelLabel: t`Cancel`,
            })
            if (sure) {
                await call(() => mergeScheduleAgain(s.id), t`Folders not merged`, 'not merged')
            }
        },
        onDuplicate: async () => {
            try {
                const copy = await duplicateSchedule(s.id)
                const copyName = copy.name
                toastSuccess(t`Created ${copyName}`, t`It is paused until you turn it on.`)
            } catch (error) {
                await reportError(error, {
                    title: t`Schedule not duplicated`,
                    log: ['[Schedules] not duplicated'],
                })
            }
        },
        onDelete: async () => {
            const sure = await ask(deleteQuestion(s), {
                title: t`Delete ${name}`,
                kind: 'warning',
                destructive: true,
                okLabel: t`Delete schedule`,
                cancelLabel: t`Keep it`,
            })
            if (!sure) return
            if (await call(() => deleteSchedule(s.id), t`Schedule not deleted`, 'not deleted')) {
                toastSuccess(t`Deleted ${name}`)
            }
        },
    }
}
