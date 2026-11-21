import { useQuery } from '@tanstack/react-query'
import { media as api } from '../../../../lib/core/api'
import { coreKey } from '../../../../lib/core/query'
import type { Media } from '../../../../lib/core/types'

// Serves a file's bytes to <img>, <video> and the preview viewers. These can't call the core's
// bindings, so the core signs a URL for the file (media.SignURL). For a limited time, that URL
// serves the file, including byte ranges, with no other credential. It is a complete URL on the
// core's loopback media server (http://127.0.0.1:port/media?…).

/** Returns a URL that streams the file at `path`, to show it (`inline`) or to download it. */
export async function mediaUrl(path: string, inline: boolean): Promise<string> {
    const signed = await api.SignURL(path, inline)
    return signed.url
}

/**
 * The staleTime of a signed URL. Fetching a new URL would restart a video and reload a document,
 * so the URL is kept while it is still fresh enough to use, even when other queries are
 * invalidated (after missed events or a config change). 'static' is the value that invalidating
 * every query leaves alone. A URL counts as fresh for the first half of its life, so whatever
 * opens it has at least that long again to play or read it.
 */
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
    /** The signed URL, once the core has created it. */
    url: string | undefined
    error: Error | null
}

export function useMediaUrl(path: string | undefined, inline = true): MediaUrl {
    const { data, error } = useQuery(mediaQuery(path, inline))
    return { url: data?.url, error: error ?? null }
}
