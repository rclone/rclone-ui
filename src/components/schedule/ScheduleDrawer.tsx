import {
    Button,
    cn,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Input,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import { ExclamationTriangle as ExclamationTriangleIcon } from '@zappicon/react'
import { useState } from 'react'
import type { Operations, Schedules } from '../../../lib/core/types'
import { coreError, formatErrorMessage, refusedFields } from '../../../lib/errors'
import { saveSchedule, useLeftOff } from '../../../lib/schedules'
import { openWindow, platform, windowName } from '../../../lib/shell'
import { WINDOWS } from '../../routes'
import { toneButton } from '../look/buttons'
import { IconTile } from '../look/IconTile'
import { Panel } from '../look/Panel'
import { SectionTitle } from '../look/SectionTitle'
import { toastSuccess, toastWarning } from '../toast'
import { useUnsavedChanges } from '../unsaved'
import {
    defaultName,
    editOperationLabel,
    OPERATION_LABELS,
    operationLine,
    pathsLine,
    scheduleOperation,
    singleRunLine,
} from './form'
import { operationIcon, operationTone } from './operations'
import WhenField from './WhenField'
import { DEFAULT_WHEN, fromCron, runsSentence, toCron, type WhenForm } from './when'

type Refused = { name?: string; when?: string; form?: string }

export function toastSaved(saved: Schedules.Schedule, title = t`Scheduled`) {
    const elsewhere = windowName() !== 'Schedules'
    toastSuccess(
        title,
        runsSentence(saved.name, saved.when),
        elsewhere ? (
            <Button
                size="sm"
                variant="flat"
                color="success"
                className="shrink-0"
                onPress={() => openWindow('/schedules')}
            >
                <Trans>Open Schedules</Trans>
            </Button>
        ) : undefined
    )
    if (saved.warning) toastWarning(t`A watcher has these folders`, saved.warning)
}

export const DELETED = t`This schedule was deleted.`

function titleOf(schedule: Schedules.Schedule | undefined): string {
    if (!schedule) return t`New schedule`
    const name = schedule.name
    return t`Edit ${name}`
}

export default function ScheduleDrawer({
    isOpen,
    onClose,
    schedule,
    form,
    initialWhen,
    onEditOperation,
}: {
    isOpen: boolean
    onClose: () => void
    schedule?: Schedules.Schedule
    form: Operations.Form
    initialWhen?: string
    onEditOperation?: () => void
}) {
    const editing = !!schedule
    const operation = scheduleOperation(form)
    const [initialName] = useState(() => schedule?.name ?? defaultName(form))
    const [name, setName] = useState(initialName)
    const [startWhen] = useState<WhenForm>(() =>
        schedule ? fromCron(schedule.when) : initialWhen ? fromCron(initialWhen) : DEFAULT_WHEN
    )
    const [when, setWhen] = useState(startWhen)
    const [whenTouched, setWhenTouched] = useState(false)
    const cron = schedule && !whenTouched ? schedule.when : toCron(when)
    const [refused, setRefused] = useState<Refused>({})

    const edited = name !== initialName || cron !== (schedule?.when ?? toCron(startWhen))
    const unsaved = useUnsavedChanges(isOpen && edited)
    const requestClose = async () => {
        if (await unsaved.confirm()) onClose()
    }

    const save = useMutation({
        mutationFn: () => saveSchedule({ id: schedule?.id ?? '', name, form, when: cron }),
        onSuccess: (saved) => {
            unsaved.forget()
            onClose()
            toastSaved(saved)
        },
        onError: (error) => {
            if (coreError(error)?.code === 'not_found') {
                setRefused({ form: DELETED })
                return
            }
            const fields = refusedFields(error)
            if (fields.name || fields.when) {
                setRefused({ name: fields.name, when: fields.when })
                return
            }
            console.error('[ScheduleDrawer] not saved', error)
            setRefused({ form: formatErrorMessage(error, t`The schedule could not be saved.`) })
        },
    })

    const changeName = (value: string) => {
        setName(value)
        setRefused((prev) => ({ ...prev, name: undefined, form: undefined }))
    }
    const changeWhen = (next: Partial<WhenForm>) => {
        setWhen((prev) => ({ ...prev, ...next }))
        setWhenTouched(true)
        setRefused((prev) => ({ ...prev, when: undefined, form: undefined }))
    }

    const Icon = operationIcon(operation)
    const leftOff = useLeftOff(form)
    const lines = [operationLine(form), singleRunLine(leftOff)].filter(
        (line): line is string => !!line
    )

    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={requestClose}
            hideCloseButton={true}
        >
            <DrawerContent
                className={cn('bg-[#f4f4f6] dark:bg-[#141416]', platform() === 'macos' && 'pt-5')}
            >
                <DrawerHeader className="px-5 pt-6 pb-2">
                    <div className="flex items-center w-full max-w-3xl gap-3.5 mx-auto">
                        <IconTile
                            icon={WINDOWS.schedules.icon}
                            tone={WINDOWS.schedules.tone}
                            size="xl"
                        />
                        <div className="flex flex-col min-w-0 gap-0.5">
                            <h2 className="text-xl font-semibold leading-tight tracking-tight truncate">
                                {titleOf(schedule)}
                            </h2>
                            <p className="font-normal leading-snug text-small text-default-500">
                                <Trans>
                                    It runs at set times while Rclone UI is open or in the
                                    background.
                                </Trans>
                            </p>
                        </div>
                    </div>
                </DrawerHeader>
                <DrawerBody className="px-5 py-5">
                    <form
                        className="flex flex-col w-full max-w-3xl gap-6 mx-auto"
                        onSubmit={(e) => {
                            e.preventDefault()
                            save.mutate()
                        }}
                    >
                        <section aria-label={t`What runs`} className="flex flex-col gap-3">
                            <SectionTitle className="px-1" title={t`What runs`} />
                            <Panel className="flex flex-col divide-y divide-divider">
                                <div className="flex items-center min-w-0 gap-3.5 px-4 py-3">
                                    <IconTile
                                        icon={Icon}
                                        tone={operationTone(operation)}
                                        size="lg"
                                    />
                                    <div className="flex flex-col min-w-0 gap-0.5">
                                        <span className="font-medium">
                                            {OPERATION_LABELS[operation]}
                                        </span>
                                        <span
                                            className="font-mono truncate text-tiny text-default-500"
                                            title={pathsLine(form)}
                                        >
                                            {pathsLine(form)}
                                        </span>
                                    </div>
                                </div>
                                {lines.map((line) => (
                                    <p
                                        key={line}
                                        className="px-4 py-3 leading-snug text-small text-default-600 text-pretty"
                                    >
                                        {line}
                                    </p>
                                ))}
                            </Panel>
                        </section>
                        <section aria-label={t`Name and time`} className="flex flex-col gap-3">
                            <SectionTitle className="px-1" title={t`Name and time`} />
                            <Panel className="flex flex-col gap-4 p-4">
                                <Input
                                    size="lg"
                                    label={t`Name`}
                                    value={name}
                                    onValueChange={changeName}
                                    isInvalid={!!refused.name}
                                    errorMessage={refused.name}
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                />
                                <WhenField
                                    when={when}
                                    cron={cron}
                                    onChange={changeWhen}
                                    error={refused.when}
                                />
                            </Panel>
                        </section>
                        <button type="submit" hidden={true} />
                    </form>
                </DrawerBody>
                <DrawerFooter className="flex-col items-stretch gap-3 px-5 pt-3 pb-5">
                    {refused.form && (
                        <div
                            role="alert"
                            className="flex items-start w-full max-w-3xl gap-3 p-3.5 mx-auto rounded-2xl bg-danger-50 text-small dark:bg-danger-50/30"
                        >
                            <ExclamationTriangleIcon className="mt-px size-5 shrink-0 text-danger" />
                            <p className="flex-1 min-w-0 break-words text-danger-700 dark:text-danger-500">
                                {refused.form}
                            </p>
                            {onEditOperation && refused.form !== DELETED && (
                                <Button
                                    size="sm"
                                    color="danger"
                                    variant="flat"
                                    className="shrink-0"
                                    onPress={onEditOperation}
                                >
                                    {editOperationLabel()}
                                </Button>
                            )}
                        </div>
                    )}
                    <div className="flex justify-end w-full max-w-3xl gap-2 mx-auto">
                        <Button
                            size="lg"
                            variant="flat"
                            onPress={requestClose}
                            className="font-medium"
                            data-focus-visible="false"
                        >
                            <Trans>Cancel</Trans>
                        </Button>
                        <Button
                            size="lg"
                            color="primary"
                            isLoading={save.isPending}
                            onPress={() => save.mutate()}
                            className={cn('px-5 font-semibold', toneButton(WINDOWS.schedules.tone))}
                            data-focus-visible="false"
                        >
                            {editing ? t`Save changes` : t`Create schedule`}
                        </Button>
                    </div>
                </DrawerFooter>
            </DrawerContent>
        </Drawer>
    )
}
