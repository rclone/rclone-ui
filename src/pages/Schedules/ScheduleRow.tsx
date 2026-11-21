import {
    Button,
    cn,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Switch,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import {
    Clock as ClockIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    FileSimplePlus as FileSimplePlusIcon,
    MoreVerticalCircle as MoreVerticalCircleIcon,
    Pen as PenIcon,
    Play as PlayIcon,
    Repeat as RepeatIcon,
    SlidersSimple as SlidersSimpleIcon,
    Trash as TrashIcon,
} from '@zappicon/react'
import { useId } from 'react'
import type { Schedules } from '../../../lib/core/types'
import { platform } from '../../../lib/shell'
import { openHistory } from '../../../lib/transfers'
import { ROW_LINE_1, ROW_LINE_2, RowStatus } from '../../components/list/ListWindow'
import { IconTile } from '../../components/look/IconTile'
import { editOperationLabel, scheduleOperation } from '../../components/schedule/form'
import { nextRunText, whenInWords } from '../../components/schedule/when'
import { WINDOWS } from '../../routes'
import { firstLine, lastRunOf, notesOf } from './status'

type MenuItem = { key: string; label: string; icon: typeof PenIcon; danger?: boolean }

export interface RowActions {
    onPause: (paused: boolean) => void
    onRunNow: () => void
    onEdit: () => void
    onEditOperation: () => void
    onMerge: () => void
    onDuplicate: () => void
    onDelete: () => void
}

/**
 * One schedule, as a row of the list. Run now and Edit show while the pointer or the focus is on
 * the row. The switch pauses the schedule. A failed run's error, and a skipped time, show under
 * the row.
 */
export default function ScheduleRow({
    schedule: s,
    now,
    actions,
}: {
    schedule: Schedules.Schedule
    now: number
    actions: RowActions
}) {
    const last = lastRunOf(s, now)
    const notes = notesOf(s)
    const switchLabel = useId()
    const operation = scheduleOperation(s.form)
    const look = WINDOWS[operation]
    const words = whenInWords(s.when)
    const bisync = operation === 'bisync'
    const name = s.name

    const menu: MenuItem[] = [
        { key: 'edit', label: t`Edit`, icon: PenIcon },
        { key: 'operation', label: editOperationLabel(), icon: SlidersSimpleIcon },
        ...(bisync ? [{ key: 'merge', label: t`Merge again`, icon: RepeatIcon }] : []),
        { key: 'duplicate', label: t`Duplicate`, icon: FileSimplePlusIcon },
        { key: 'delete', label: t`Delete`, icon: TrashIcon, danger: true },
    ]

    return (
        <div className="flex flex-col gap-2.5 py-3.5 pl-4 pr-3 group/row">
            <div className="flex items-center gap-3.5">
                <IconTile
                    icon={look.icon}
                    tone={look.tone}
                    size="lg"
                    className={cn(
                        'transition-[opacity,filter] duration-200 ease-out',
                        s.paused && 'opacity-40 grayscale'
                    )}
                />
                <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                    <span
                        className={cn(
                            'font-semibold text-[15px]',
                            ROW_LINE_1,
                            s.paused && 'text-default-500'
                        )}
                    >
                        {s.name}
                    </span>
                    <Tooltip
                        content={words ?? <span className="font-mono">{s.when}</span>}
                        color="foreground"
                        delay={300}
                        placement="bottom-start"
                    >
                        <span className={cn('self-start max-w-full', ROW_LINE_2)}>
                            {s.paused ? t`Paused` : nextRunText(s.nextRun, now)}
                            {/* The tooltip shows on hover only, so a screen reader reads it here. */}
                            <span className="sr-only">, {words ?? s.when}</span>
                        </span>
                    </Tooltip>
                </div>
                <RowStatus
                    kind={last.kind}
                    label={last.label}
                    when={last.ago}
                    note={last.note}
                    onOpen={last.transferId ? () => openHistory(last.transferId) : undefined}
                    openTip={t`Open in History`}
                />
                <div className="flex items-center gap-0.5 shrink-0">
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none">
                        <Tooltip content={s.running ? t`Running` : t`Run now`} color="foreground">
                            {/* A disabled button gets no hover, so the tooltip sits on a wrapper. */}
                            <span>
                                <Button
                                    isIconOnly={true}
                                    size="sm"
                                    variant="light"
                                    aria-label={t`Run ${name} now`}
                                    isDisabled={s.running}
                                    onPress={actions.onRunNow}
                                    className="text-default-600"
                                >
                                    <PlayIcon className="size-4" />
                                </Button>
                            </span>
                        </Tooltip>
                        <Tooltip content={t`Edit`} color="foreground">
                            <Button
                                isIconOnly={true}
                                size="sm"
                                variant="light"
                                aria-label={t`Edit ${name}`}
                                onPress={actions.onEdit}
                                className="text-default-600"
                            >
                                <PenIcon className="size-4" />
                            </Button>
                        </Tooltip>
                    </div>
                    {/* HeroUI's Switch drops its aria-label when it has no text, so the
                    switch is named by a hidden label instead. */}
                    <span id={switchLabel} className="sr-only">
                        {s.paused ? t`Resume ${name}` : t`Pause ${name}`}
                    </span>
                    <Switch
                        size="sm"
                        isSelected={!s.paused}
                        onValueChange={(on) => actions.onPause(!on)}
                        aria-labelledby={switchLabel}
                        data-focus-visible="false"
                        classNames={{ base: 'mx-1.5', wrapper: 'me-0' }}
                    />
                    <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
                        <DropdownTrigger>
                            <Button
                                isIconOnly={true}
                                size="sm"
                                variant="light"
                                aria-label={t`More for ${name}`}
                                className="text-default-600"
                            >
                                <MoreVerticalCircleIcon className="size-4" />
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label={t`Actions for ${name}`}
                            items={menu}
                            disabledKeys={s.running ? ['merge'] : []}
                            onAction={(key) => {
                                if (key === 'edit') actions.onEdit()
                                if (key === 'operation') actions.onEditOperation()
                                if (key === 'merge') actions.onMerge()
                                if (key === 'duplicate') actions.onDuplicate()
                                if (key === 'delete') actions.onDelete()
                            }}
                        >
                            {(item) => (
                                <DropdownItem
                                    key={item.key}
                                    color={item.danger ? 'danger' : undefined}
                                    className={item.danger ? 'text-danger' : undefined}
                                    startContent={<item.icon className="size-4" />}
                                >
                                    {item.label}
                                </DropdownItem>
                            )}
                        </DropdownMenu>
                    </Dropdown>
                </div>
            </div>
            {(notes.error || notes.skipped) && (
                <div className="flex flex-col gap-1.5 ml-[3.125rem]">
                    {notes.error && (
                        <Tooltip
                            content={<span className="whitespace-pre-wrap">{notes.error}</span>}
                            color="foreground"
                            className="max-w-md"
                            delay={300}
                        >
                            <p className="flex items-center gap-2 px-3 py-2 rounded-xl bg-danger/10 text-small text-danger-600 dark:text-danger-500">
                                <ExclamationTriangleIcon className="size-4 shrink-0" />
                                <span className="truncate">{firstLine(notes.error)}</span>
                            </p>
                        </Tooltip>
                    )}
                    {notes.skipped && (
                        <p className="flex items-center gap-2 px-3 py-2 rounded-xl bg-warning/10 text-small text-warning-700 dark:text-warning-500">
                            <ClockIcon className="size-4 shrink-0" />
                            <span className="truncate">{notes.skipped}</span>
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}
