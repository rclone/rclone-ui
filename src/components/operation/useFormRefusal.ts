import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDebounce } from 'use-debounce'
import { mounts, serves, transfers } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'
import type { Operations } from '../../../lib/core/types'
import { coreError } from '../../../lib/errors'

// What the core says about a page's form: its refusal, shown while the user types, and its
// command (scriptOf). The core checks the form with the same rules that its start uses
// (operations.CheckForm for a transfer, and the command line of a mount or a serve), without
// asking rclone about the paths. So the page shows the refusal that Start would give, in the same
// words, and keeps no copy of the rules. The start still checks everything again.

export type CheckedForm =
    | { form: Operations.Form }
    | { mount: Operations.MountArgs }
    | { serve: Operations.ServeArgs }

/**
 * The core's refusal of a form: its message, and the field that it is on when it has one. A
 * refused option is on its group's field, such as `options.config`.
 */
export interface FormRefusal {
    message: string
    field?: string
}

/** How long the form must stay the same before the core is asked, in milliseconds. */
const DELAY = 400

function serviceOf(checked: CheckedForm): 'transfers' | 'mounts' | 'serves' {
    if ('mount' in checked) return 'mounts'
    if ('serve' in checked) return 'serves'
    return 'transfers'
}

async function check(checked: CheckedForm): Promise<void> {
    if ('mount' in checked) return mounts.Check(checked.mount)
    if ('serve' in checked) return serves.Check(checked.serve)
    return transfers.Check(checked.form)
}

/**
 * The form as rclone commands and as a program for rclone-sdk, as the Copy command shows them
 * (CommandModal).
 */
export function scriptOf(checked: CheckedForm): Promise<Operations.Script> {
    if ('mount' in checked) return mounts.Command(checked.mount)
    if ('serve' in checked) return serves.Command(checked.serve)
    return transfers.Command(checked.form)
}

/**
 * The refusal in a failed check, or null when the failure isn't a refusal of the form, such as
 * a core that hasn't started yet. Only a refusal is shown on the page.
 */
export function refusalOf(error: unknown): FormRefusal | null {
    const e = coreError(error)
    if (e?.code !== 'invalid') return null
    const field = e.fields?.[0]?.field
    return field ? { message: e.message, field } : { message: e.message }
}

/**
 * The core's refusal of `checked`, asked 400 ms after the form stops changing, or undefined when
 * the core takes it. The last answer stays while a new one is on its way. Pass undefined while
 * the page's own checks fail, and nothing is asked.
 */
export function useFormRefusal(checked: CheckedForm | undefined): FormRefusal | undefined {
    const key = checked ? JSON.stringify(checked) : ''
    const [asked] = useDebounce(key, DELAY)
    const service = checked ? serviceOf(checked) : 'transfers'
    const query = useQuery({
        queryKey: coreKey(service, 'Check', asked),
        queryFn: async () => {
            try {
                await check(JSON.parse(asked) as CheckedForm)
                return null
            } catch (error) {
                return refusalOf(error)
            }
        },
        enabled: asked !== '',
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
        placeholderData: keepPreviousData,
    })
    if (!checked) return undefined
    return query.data ?? undefined
}
