import { useQuery } from '@tanstack/react-query'

export type Role = 'owner' | 'admin' | 'member'

export interface SessionUser {
    id: string
    email: string
    role: Role
}

export interface Session {
    authenticated: boolean
    /** The signed-in account; null without a session. */
    user: SessionUser | null
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

/** Who this tab is signed in as (`GET /api/session`, answered without a session too). */
export async function getSession(): Promise<Session> {
    const response = await fetch('/api/session', { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`session check failed (${response.status})`)
    return (await response.json()) as Session
}

export function useSession() {
    return useQuery({
        queryKey: ['session'],
        queryFn: getSession,
        // Asked again on every mount: the page must not trust an answer from before a sign-in,
        // and the query is kept out of the persisted cache (lib/query.ts).
        staleTime: 0,
        meta: { persist: false },
    })
}
