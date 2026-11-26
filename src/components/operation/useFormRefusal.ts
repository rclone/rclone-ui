import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDebounce } from 'use-debounce'
import { mounts, serves, transfers } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'
import type { Operations } from '../../../lib/core/types'
import { coreError } from '../../../lib/errors'

export type CheckedForm =
    | { form: Operations.Form }
    | { mount: Operations.MountArgs }
    | { serve: Operations.ServeArgs }

export interface FormRefusal {
    message: string
    field?: string
}

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

export function scriptOf(checked: CheckedForm): Promise<Operations.Script> {
    if ('mount' in checked) return mounts.Command(checked.mount)
    if ('serve' in checked) return serves.Command(checked.serve)
    return transfers.Command(checked.form)
}

export function refusalOf(error: unknown): FormRefusal | null {
    const e = coreError(error)
    if (e?.code !== 'invalid') return null
    const field = e.fields?.[0]?.field
    return field ? { message: e.message, field } : { message: e.message }
}

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
