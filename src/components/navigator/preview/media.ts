import { useQuery } from '@tanstack/react-query'
import { media as api } from '../../../../lib/core/api'
import { coreKey } from '../../../../lib/core/query'
import type { Media } from '../../../../lib/core/types'

export async function mediaUrl(path: string, inline: boolean): Promise<string> {
    const signed = await api.SignURL(path, inline)
    return signed.url
}

/** `'static'` is the staleTime that invalidating every query leaves alone. */
export function keepWhileFresh(query: {
    state: { data?: Media.SignedURL; dataUpdatedAt: number }
}): 'static' | 0 {
    const { data, dataUpdatedAt: signedAt } = query.state
    if (!data?.expiresAt) return 0
    return Date.now() < signedAt + (data.expiresAt - signedAt) / 2 ? 'static' : 0
}

export function mediaQuery(path: string | undefined, inline: boolean) {
    return {
        queryKey: coreKey('media', 'SignURL', { path: path ?? '', inline }),
        queryFn: () => api.SignURL(path ?? '', inline),
        enabled: !!path,
        staleTime: keepWhileFresh,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    }
}

export interface MediaUrl {
    url: string | undefined
    error: Error | null
}

export function useMediaUrl(path: string | undefined, inline = true): MediaUrl {
    const { data, error } = useQuery(mediaQuery(path, inline))
    return { url: data?.url, error: error ?? null }
}
