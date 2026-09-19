import { useMutation } from '@tanstack/react-query'

import { onErrorDialog } from '../../../lib/errors'
import { notify } from '../../../lib/notifications'
import { createScheduledTask } from '../../../lib/scheduler'
import type { ScheduledTask } from '../../../types/schedules'
import { prompt } from '../../../lib/api/dialog'

/**
 * The schedule mutation shared by the operation pages: page-specific validation (path checks)
 * → cron validation → name prompt → createScheduledTask,
 * which persists the task and registers it with the server's scheduler. Each run replays the
 * pre-serialized requests built from `buildArgs()` output.
 */
export function useScheduleTask({
    operation,
    cronExpression,
    buildArgs,
    validate,
}: {
    operation: ScheduledTask['operation']
    cronExpression: string | null
    /** The operation's arguments; the caller keeps them matched to `operation`. */
    buildArgs: () => ScheduledTask['args']
    validate?: () => void
}) {
    return useMutation({
        mutationFn: async () => {
            validate?.()

            if (!cronExpression) {
                throw new Error('Enter a cron expression to schedule this operation')
            }

            const name = await prompt({
                title: 'Schedule Name',
                message: 'Enter a name for this schedule',
                default: `New Schedule ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' })}`,
            })

            if (!name) {
                throw new Error('Schedule name is required')
            }

            await createScheduledTask({
                name,
                operation,
                cron: cronExpression,
                args: buildArgs(),
            })
        },
        onSuccess: async () => {
            await notify({
                title: 'Success',
                body: 'New schedule has been created',
            })
        },
        onError: onErrorDialog('Schedule', 'Failed to schedule task', {
            capture: false,
            log: ['Error scheduling task:'],
        }),
    })
}
