import { useQuery } from '@tanstack/react-query'
import { schedulerValidateCron } from '../../../lib/scheduler'
import CronEditor from '../CronEditor'

/**
 * The Schedule options-accordion section for the operation pages: the cron editor plus live
 * per-platform validation (scheduler_validate_cron). Rendered as the 'cron' accordion item.
 */
export default function CronSection({
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
