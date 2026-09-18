import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import rclone from '../../../lib/rclone/client'
import { OVERRIDES, OWN_OAUTH_TYPES } from '../../../lib/rclone/overrides'

export type RemoteValues = Record<string, any>

async function loadProviders() {
    return (await rclone('/config/providers')).providers
}

/**
 * The remote form as both drawers see it. `saved` is what rclone holds (nothing for a new
 * remote), `pending` what the user changed here, `effective` the two together: the backend,
 * its fields for the chosen provider, and the credentials rule all read `effective`; the save
 * reads `pending` (Edit writes only what changed). `exclude` is the drawer's own list of
 * backends it never offers.
 */
export function useRemoteForm({
    saved,
    exclude,
}: {
    saved?: RemoteValues
    exclude: readonly string[]
}) {
    const [pending, setPending] = useState<RemoteValues>({})

    const providersQuery = useQuery({ queryKey: ['backends'], queryFn: loadProviders })
    const backends = useMemo(
        () =>
            (providersQuery.data ?? [])
                .filter((backend) => !exclude.includes(backend.Name))
                .map((backend) => {
                    const override = OVERRIDES[backend.Name as keyof typeof OVERRIDES]
                    return {
                        ...backend,
                        Description: override?.Description || backend.Description,
                    }
                })
                .sort((a, b) => a.Name.localeCompare(b.Name)),
        [providersQuery.data, exclude]
    )

    const effective = useMemo<RemoteValues>(
        () => ({ ...(saved ?? {}), ...pending }),
        [saved, pending]
    )
    const backend = useMemo(
        () => (effective.type ? (backends.find((b) => b.Name === effective.type) ?? null) : null),
        [backends, effective.type]
    )

    // The provider decides which of a backend's options apply: those without a provider list,
    // those naming this provider, and for S3's "Other" the ones every named provider excludes.
    const fields = useMemo(() => {
        const provider = effective.provider as string | undefined
        const all =
            backend?.Options.filter((opt) => {
                if (!opt.Provider) return true
                if (provider && opt.Provider.includes(provider) && !opt.Provider.startsWith('!')) {
                    return true
                }
                return effective.type === 's3' && provider === 'Other' && opt.Provider.includes('!')
            }) ?? []
        return {
            normal: all.filter((opt) => !opt.Advanced),
            advanced: all.filter((opt) => opt.Advanced),
        }
    }, [backend, effective.provider, effective.type])

    // Google Drive / Google Photos require the user's own OAuth credentials (rclone is retiring
    // its shared client-id): nothing is saved until both are there, in what is saved or typed.
    const missingCredentials = useMemo(
        () =>
            OWN_OAUTH_TYPES.includes(effective.type ?? '')
                ? ['client_id', 'client_secret'].filter((f) => !(effective[f] || '').trim())
                : [],
        [effective]
    )

    return { backends, backend, fields, saved, pending, setPending, effective, missingCredentials }
}
