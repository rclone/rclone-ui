import { Button, Input, Select, SelectItem } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import cronstrue from 'cronstrue'
import { ClockIcon, XIcon } from 'lucide-react'
import type React from 'react'
import { startTransition, useEffect, useMemo, useState } from 'react'
import { schedulerValidateCron } from '@/lib/scheduler'

interface CronEditorProps {
    expression: string | null
    onChange: (newExpression: string | null) => void
    /** Platform-specific validation error from scheduler_validate_cron. */
    error?: string | null
}

interface CronFieldProps {
    label: string
    value: string
    onChange: (value: string) => void
    options: string[]
}

const DEFAULT_OPTIONS = ['*', '*/5', '*/10', '*/15', '*/30']

export default function CronEditor({ expression, onChange, error }: CronEditorProps) {
    // Controlled: the parent's `expression` is the only state, and a change is announced from
    // the handler that made it. Nothing is emitted because the parent re-rendered with a new
    // `onChange` (the old sync effect echoed the value back on every identity change, which
    // looped under a reducer), and the field can never show something other than what the
    // parent will save (the edit drawer coerces a cleared field to '* * * * *').
    const [minute, hour, dayOfMonth, month, dayOfWeek] = useMemo(
        () => (expression || '* * * * *').split(' '),
        [expression]
    )

    const readableDescription = useMemo(() => {
        if (!expression)
            return 'Enter a cron expression to have this task run at regular intervals (or just once)'
        let description: string
        try {
            description = cronstrue.toString(expression, { verbose: true })
            description += '. Runs whenever the server is up.'
        } catch {
            description = 'Invalid cron expression'
        }
        return description
    }, [expression])

    const handleFieldChange = (field: string, value: string) => {
        const parts = (expression || '* * * * *').split(' ')
        const index = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'].indexOf(field)
        if (index !== -1) {
            parts[index] = value
            onChange(parts.join(' '))
        }
    }

    return (
        <div className="flex flex-col w-full gap-2">
            <Input
                value={expression || ''}
                onChange={(e) => onChange(e.target.value.length > 0 ? e.target.value : null)}
                placeholder="Enter cron expression (e.g. 0 0 * * *)"
                size="lg"
                startContent={<ClockIcon className="text-default-400" />}
                isClearable={true}
                onClear={() => onChange(null)}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck="false"
            />

            <div className="grid grid-cols-5 gap-2">
                <CronField
                    label="Minute"
                    value={minute}
                    onChange={(v) => handleFieldChange('minute', v)}
                    options={generateOptions(0, 59)}
                />
                <CronField
                    label="Hour"
                    value={hour}
                    onChange={(v) => handleFieldChange('hour', v)}
                    options={generateOptions(0, 23)}
                />
                <CronField
                    label="Day (Month)"
                    value={dayOfMonth}
                    onChange={(v) => handleFieldChange('dayOfMonth', v)}
                    options={generateOptions(1, 31)}
                />
                <CronField
                    label="Month"
                    value={month}
                    onChange={(v) => handleFieldChange('month', v)}
                    options={generateOptions(1, 12)}
                />
                <CronField
                    label="Day (Week)"
                    value={dayOfWeek}
                    onChange={(v) => handleFieldChange('dayOfWeek', v)}
                    options={generateOptions(0, 7)}
                />
            </div>

            {error ? (
                <div className="text-sm text-danger-500">{error}</div>
            ) : (
                <div className="text-sm text-neutral-500">{readableDescription}</div>
            )}
        </div>
    )
}

function CronField({ label, value, onChange, options }: CronFieldProps) {
    const [isCustom, setIsCustom] = useState(false)

    useEffect(() => {
        const isCustom =
            !DEFAULT_OPTIONS.includes(value) &&
            !options.includes(value) &&
            value !== '*' &&
            value !== 'custom'

        startTransition(() => {
            setIsCustom(isCustom)
        })
    }, [value, options])

    const handleCustomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        onChange(e.target.value)
    }

    return (
        <div>
            {isCustom ? (
                <Input
                    label={label}
                    value={value}
                    onChange={handleCustomChange}
                    className="max-w-xs"
                    endContent={
                        <Button
                            isIconOnly={true}
                            size="sm"
                            variant="light"
                            onPress={() => setIsCustom(false)}
                        >
                            <XIcon className="w-4 h-4 text-default-400" />
                        </Button>
                    }
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                />
            ) : (
                <Select
                    label={label}
                    selectedKeys={[value]}
                    onSelectionChange={(key) => {
                        const item = key.currentKey
                        if (!item) return
                        if (item === 'custom') {
                            setIsCustom(true)
                        } else {
                            onChange(item)
                        }
                    }}
                    className="max-w-xs"
                    items={[
                        ...DEFAULT_OPTIONS.map((option) => ({ key: option, label: option })),
                        ...options.map((option) => ({ key: option, label: option })),
                        { key: 'custom', label: 'Custom' },
                    ]}
                >
                    {(item) => (
                        <SelectItem key={item.key} title={item.label}>
                            {item.key}
                        </SelectItem>
                    )}
                </Select>
            )}
        </div>
    )
}

function generateOptions(start: number, end: number): string[] {
    return Array.from({ length: end - start + 1 }, (_, i) => (start + i).toString())
}

/**
 * The Schedule section of the operation pages' options accordion: the editor plus live
 * validation by the server's own matcher (scheduler_validate_cron).
 */
export function CronSection({
    expression,
    onChange,
}: {
    expression: string | null
    onChange: (expr: string | null) => void
}) {
    const validation = useQuery({
        queryKey: ['scheduler', 'validate-cron', expression],
        queryFn: () => schedulerValidateCron(expression ?? ''),
        enabled: !!expression,
    })
    const error =
        expression && validation.data && !validation.data.valid
            ? (validation.data.error ?? 'Invalid cron expression')
            : null

    return <CronEditor expression={expression} onChange={onChange} error={error} />
}
