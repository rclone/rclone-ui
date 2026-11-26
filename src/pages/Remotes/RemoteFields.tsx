import { cn } from '@heroui/react'
import { Trans } from '@lingui/react/macro'
import { AngleDownSmall as AngleDownSmallIcon } from '@zappicon/react'
import { type Dispatch, type SetStateAction, useMemo, useState } from 'react'
import { type Option, useBackends, useProviderOptions } from '../../../lib/catalog'
import { formatNumber } from '../../../lib/format'
import { OVERRIDES, OWN_OAUTH_TYPES } from '../../../lib/rclone/overrides'
import RemoteField, { type RemoteValues } from './RemoteField'

export function useRemoteForm({ saved }: { saved?: RemoteValues } = {}) {
    const [pending, setPending] = useState<RemoteValues>({})

    const catalog = useBackends()
    const savedType = saved?.type
    const backends = useMemo(
        () =>
            (catalog ?? [])
                .filter((backend) => !backend.hidden || backend.name === savedType)
                .map((backend) => {
                    const override = OVERRIDES[backend.name as keyof typeof OVERRIDES]
                    return {
                        ...backend,
                        description: override?.Description || backend.description,
                    }
                })
                .sort((a, b) => a.name.localeCompare(b.name)),
        [catalog, savedType]
    )

    const effective = useMemo<RemoteValues>(
        () => ({ ...(saved ?? {}), ...pending }),
        [saved, pending]
    )

    const { options, current: fieldsReady } = useProviderOptions(effective.type, effective.provider)
    const fields = useMemo(() => {
        const all = options ?? []
        return {
            normal: all.filter((opt) => !opt.advanced),
            advanced: all.filter((opt) => opt.advanced),
        }
    }, [options])

    const missingCredentials = useMemo(
        () =>
            OWN_OAUTH_TYPES.includes(effective.type ?? '')
                ? ['client_id', 'client_secret'].filter((f) => !(effective[f] || '').trim())
                : [],
        [effective]
    )

    return { backends, fields, fieldsReady, pending, setPending, effective, missingCredentials }
}

export function shownValues(
    values: RemoteValues,
    fields: { normal: readonly Option[]; advanced: readonly Option[] }
): RemoteValues {
    const shown = new Set([...fields.normal, ...fields.advanced].map((opt) => opt.name))
    return Object.fromEntries(Object.entries(values).filter(([name]) => shown.has(name)))
}

export function valuesAsText(values: RemoteValues): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(values)) {
        if (v === undefined || v === null) continue
        out[k] = String(v)
    }
    return out
}

export default function RemoteFields({
    fields,
    values,
    saved,
    setValues,
    disabledFields = [],
    showMore,
    onToggleMore,
}: {
    fields: { normal: Option[]; advanced: Option[] }
    values: RemoteValues
    saved?: RemoteValues
    setValues: Dispatch<SetStateAction<RemoteValues>>
    disabledFields?: readonly string[]
    showMore: boolean
    onToggleMore: () => void
}) {
    const extra = fields.advanced.filter((opt) => !opt.hidden).length
    return (
        <>
            {fields.normal.map((opt) => (
                <RemoteField
                    key={opt.name}
                    option={opt}
                    config={values}
                    saved={saved}
                    setConfig={setValues}
                    isDisabled={disabledFields.includes(opt.name)}
                />
            ))}

            {extra > 0 && (
                <div className="flex flex-col gap-4 pt-1">
                    <button
                        type="button"
                        onClick={onToggleMore}
                        aria-expanded={showMore}
                        className="flex items-center self-start gap-2 -mx-2 px-2 py-1.5 rounded-lg text-small font-medium text-default-600 outline-none transition-colors duration-150 hover:bg-default-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                    >
                        <AngleDownSmallIcon
                            className={cn(
                                'size-4 transition-transform duration-150 motion-reduce:transition-none',
                                !showMore && '-rotate-90'
                            )}
                        />
                        <span>
                            <Trans comment="A button that shows a backend's advanced options. A count follows.">
                                More options
                            </Trans>
                        </span>
                        <span className="px-1.5 rounded-full text-tiny tabular-nums bg-default-100 text-default-500">
                            {formatNumber(extra)}
                        </span>
                    </button>

                    {showMore &&
                        fields.advanced.map((opt) => (
                            <RemoteField
                                key={opt.name}
                                option={opt}
                                config={values}
                                saved={saved}
                                setConfig={setValues}
                            />
                        ))}
                </div>
            )}
        </>
    )
}
