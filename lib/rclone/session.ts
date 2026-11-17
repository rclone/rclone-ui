import { invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { type Host, LOCAL_HOST_ID } from '../hosts'

export interface RcSession {
    user: string
    pass: string
}

let localSession: Promise<RcSession> | null = null

export function getLocalSession(): Promise<RcSession> {
    if (!localSession) {
        const pending = invoke<RcSession>('rc_session')
        localSession = pending
        pending.catch(() => {
            if (localSession === pending) localSession = null
        })
    }
    return localSession
}

export async function getAuthHeader(
    host: Pick<Host, 'authUser' | 'authPassword'> & { id?: Host['id'] }
): Promise<string | undefined> {
    if (host.id === LOCAL_HOST_ID) {
        const { user, pass } = await getLocalSession()
        return `Basic ${btoa(`${user}:${pass}`)}`
    }
    if (!host.authUser) return undefined
    return `Basic ${btoa(`${host.authUser}:${host.authPassword ?? ''}`)}`
}

export function rcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    headers.set('Origin', '')
    return tauriFetch(request, { headers, signal: request.signal })
}
