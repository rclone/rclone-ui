import { cn, Input, Select, SelectItem } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { useWhenDescription } from '../../../lib/schedules'
import {
    CUSTOM_PLACEHOLDER,
    nextRunsLine,
    WEEKDAYS,
    WHEN_CHOICES,
    type WhenForm,
    type WhenKind,
} from './when'

const MINUTES = Array.from({ length: 60 }, (_, m) => ({ value: m, label: pad(m) }))
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: pad(h) }))
const PAST_THE_HOUR = MINUTES.map((m) => ({ ...m, label: `:${m.label}` }))
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))
const DAYS = WEEKDAYS.map((d) => ({ value: d.day, label: d.name }))

function pad(n: number) {
    return String(n).padStart(2, '0')
}

function NumberSelect({
    label,
    value,
    options,
    onChange,
    className,
}: {
    label: string
    value: number
    options: { value: number; label: string }[]
    onChange: (value: number) => void
    className?: string
}) {
    return (
        <Select
            label={label}
            className={cn('shrink-0', className)}
            selectedKeys={[String(value)]}
            disallowEmptySelection={true}
            onSelectionChange={(keys) => {
                const picked = [...keys][0]
                if (picked !== undefined) onChange(Number(picked))
            }}
        >
            {options.map((o) => (
                <SelectItem key={String(o.value)}>{o.label}</SelectItem>
            ))}
        </Select>
    )
}

/**
 * The "When" field: a choice, the fields it needs, and the next runs (or the problem), which the
 * core works out 300 ms after the last change. Times are on the 24-hour clock, as the list and
 * the next runs show them.
 */
export default function WhenField({
    when,
    cron,
    onChange,
    error,
}: {
    when: WhenForm
    cron: string
    onChange: (next: Partial<WhenForm>) => void
    error?: string
}) {
    const { description } = useWhenDescription(cron)
    // While the user types, the line under the field keeps the last answer.
    const shown = cron.trim() === '' ? undefined : description.data
    const problem = error ?? shown?.problem
    const atTime = when.kind !== 'hour' && when.kind !== 'custom'

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-start gap-3">
                <Select
                    label={t({
                        message: 'When',
                        comment: 'Label of the field for when a schedule runs.',
                    })}
                    className="w-48 shrink-0"
                    selectedKeys={[when.kind]}
                    disallowEmptySelection={true}
                    onSelectionChange={(keys) => {
                        const kind = [...keys][0] as WhenKind | undefined
                        if (!kind) return
                        // Custom starts from the expression that the choice wrote.
                        onChange(
                            kind === 'custom' && when.kind !== 'custom'
                                ? { kind, expression: cron }
                                : { kind }
                        )
                    }}
                >
                    {WHEN_CHOICES.map((choice) => (
                        <SelectItem key={choice.kind}>{choice.label}</SelectItem>
                    ))}
                </Select>
                {when.kind === 'hour' && (
                    <NumberSelect
                        label={t`At minute`}
                        className="w-36"
                        value={when.minute}
                        options={PAST_THE_HOUR}
                        onChange={(minute) => onChange({ minute })}
                    />
                )}
                {when.kind === 'week' && (
                    <NumberSelect
                        label={t({
                            message: 'On',
                            comment:
                                'Label of the field for the day of the week a schedule runs on.',
                        })}
                        className="w-40"
                        value={when.weekday}
                        options={DAYS}
                        onChange={(weekday) => onChange({ weekday })}
                    />
                )}
                {when.kind === 'month' && (
                    <NumberSelect
                        label={t({
                            message: 'On day',
                            comment:
                                'Label of the field for the day of the month a schedule runs on.',
                        })}
                        className="w-28"
                        value={when.monthDay}
                        options={MONTH_DAYS}
                        onChange={(monthDay) => onChange({ monthDay })}
                    />
                )}
                {atTime && (
                    <>
                        <NumberSelect
                            label={t`At hour`}
                            className="w-28"
                            value={when.hour}
                            options={HOURS}
                            onChange={(hour) => onChange({ hour })}
                        />
                        <NumberSelect
                            label={t`Minute`}
                            className="w-28"
                            value={when.minute}
                            options={MINUTES}
                            onChange={(minute) => onChange({ minute })}
                        />
                    </>
                )}
                {when.kind === 'custom' && (
                    <Input
                        label={t`Cron expression`}
                        placeholder={CUSTOM_PLACEHOLDER}
                        className="flex-1 min-w-48"
                        classNames={{ input: 'font-mono' }}
                        value={when.expression}
                        onValueChange={(expression) => onChange({ expression })}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck="false"
                    />
                )}
            </div>
            {problem ? (
                <p className="px-1 text-small text-danger">{problem}</p>
            ) : shown && shown.next.length > 0 ? (
                <p className="px-1 text-small text-default-500">
                    {nextRunsLine(shown.next, shown.zone)}
                </p>
            ) : null}
        </div>
    )
}
