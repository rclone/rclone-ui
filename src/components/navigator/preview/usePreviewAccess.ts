import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import type { Host } from '../../../../lib/hosts'
import { getAuthHeader } from '../../../../lib/rclone/session'

export function useAuthHeader(host: Host | null): { ready: boolean; header?: string } {
    const id = host?.id
    const authUser = host?.authUser
    const authPassword = host?.authPassword
    const [result, setResult] = useState<{ header?: string } | null>(null)

    useEffect(() => {
        setResult(null)
        if (!id) return
        let cancelled = false
        getAuthHeader({ id, authUser, authPassword }).then(
            (header) => {
                if (!cancelled) setResult({ header })
            },
            (error) => {
                console.error('[useAuthHeader] failed to get the rc password', error)
                if (!cancelled) setResult({})
            }
        )
        return () => {
            cancelled = true
        }
    }, [id, authUser, authPassword])

    return { ready: result !== null, header: result?.header }
}

export function useMediaUrl(
    url: string | null,
    authHeader: string | undefined,
    name: string,
    enabled: boolean
): { url: string | null; error: string | null } {
    const [state, setState] = useState<{ url: string | null; error: string | null }>({
        url: null,
        error: null,
    })

    useEffect(() => {
        setState({ url: null, error: null })
        if (!url || !enabled) return
        let cancelled = false
        let registered: string | null = null
        invoke<string>('media_register', { url, authorization: authHeader ?? null, name }).then(
            (mediaUrl) => {
                if (cancelled) {
                    invoke('media_release', { url: mediaUrl })
                    return
                }
                registered = mediaUrl
                setState({ url: mediaUrl, error: null })
            },
            (error) => {
                console.error('[useMediaUrl] failed to register the preview', error)
                if (!cancelled) setState({ url: null, error: String(error) })
            }
        )
        return () => {
            cancelled = true
            if (registered) invoke('media_release', { url: registered })
        }
    }, [url, authHeader, name, enabled])

    return state
}
