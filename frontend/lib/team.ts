import { useQuery } from '@tanstack/react-query'
import { rpc } from './api/rpc'
import type { Role } from './api/session'

// Settings › Team: the server's accounts (`src/team.rs`). The rules (who may change
// what) live there; errors come back as plain sentences for the dialogs.

export interface Member {
    id: string
    email: string
    role: Role
    createdAt: string
}

/** The roles an admin can hand out; there is one owner, seeded at first start. */
export type MemberRole = Exclude<Role, 'owner'>

export async function listMembers(): Promise<Member[]> {
    return await rpc<Member[]>('team_list')
}

export async function addMember(
    email: string,
    password: string,
    role: MemberRole
): Promise<Member> {
    return await rpc<Member>('team_add', { email, password, role })
}

export async function removeMember(id: string): Promise<void> {
    await rpc('team_remove', { id })
}

export async function setMemberRole(id: string, role: MemberRole): Promise<Member> {
    return await rpc<Member>('team_set_role', { id, role })
}

/** Your own password needs `current`; an admin resets a member's without it. */
export async function setMemberPassword(
    id: string,
    password: string,
    current?: string
): Promise<void> {
    await rpc('team_set_password', { id, password, current })
}

export async function setMemberEmail(id: string, email: string): Promise<Member> {
    return await rpc<Member>('team_set_email', { id, email })
}

/** `enabled: false` where there are no accounts (the desktop's token mode). */
export function useTeam(enabled = true) {
    return useQuery({ queryKey: ['team'], queryFn: listMembers, meta: { persist: false }, enabled })
}
