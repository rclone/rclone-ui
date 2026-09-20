import {
    Button,
    Card,
    CardBody,
    Chip,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Input,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@heroui/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontalIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { ask, message, prompt } from '@/dialog'
import { ROLE_LABEL, type Role, type SessionUser, useSession } from '@/server/session'
import {
    type Member,
    removeMember,
    setMemberEmail,
    setMemberPassword,
    setMemberRole,
    useTeam,
} from '@/lib/team'
import BaseSection from './BaseSection'
import TeamMemberModal from './TeamMemberModal'

const ROLE_COLOR: Record<Role, 'primary' | 'secondary' | 'default'> = {
    owner: 'primary',
    admin: 'secondary',
    member: 'default',
}

// Not awaited: a mutation stays pending until its callbacks settle, and the dialog waits for
// a click.
function explain(error: unknown) {
    void message(error instanceof Error ? error.message : String(error), {
        title: 'Team',
        kind: 'error',
    })
}

// Settings › Team: who can sign in to this server. Admins add and remove members and reset their
// passwords; the owner (seeded from --password) cannot be removed or demoted; everyone changes
// their own email and password.
export default function TeamSection() {
    const session = useSession()
    const me = session.data?.user ?? null
    const team = useTeam()
    const canManage = me?.role === 'owner' || me?.role === 'admin'
    const [isDrawerOpen, setDrawerOpen] = useState(false)
    const [passwordFor, setPasswordFor] = useState<Member | null>(null)

    return (
        <BaseSection
            header={{
                title: 'Team',
                endContent: canManage ? (
                    <Button
                        onPress={() => setDrawerOpen(true)}
                        variant="flat"
                        color="primary"
                        size="sm"
                        startContent={<PlusIcon className="w-4 h-4" />}
                        data-focus-visible="false"
                    >
                        Add member
                    </Button>
                ) : undefined,
            }}
        >
            <div className="flex flex-col gap-4 px-4 pb-10">
                <ul aria-label="Members" className="flex flex-col gap-2.5">
                    {(team.data ?? []).map((member) => (
                        <MemberCard
                            key={member.id}
                            member={member}
                            me={me}
                            canManage={canManage}
                            onPassword={() => setPasswordFor(member)}
                        />
                    ))}
                </ul>
                {team.isPending && (
                    <p className="py-10 text-sm text-center text-default-500">Loading…</p>
                )}
                {team.isError && (
                    <p className="py-10 text-sm text-center text-danger">
                        {team.error instanceof Error ? team.error.message : String(team.error)}
                    </p>
                )}
            </div>
            <TeamMemberModal isOpen={isDrawerOpen} onClose={() => setDrawerOpen(false)} />
            <PasswordModal
                member={passwordFor}
                isOwn={passwordFor !== null && passwordFor.id === me?.id}
                onClose={() => setPasswordFor(null)}
            />
        </BaseSection>
    )
}

function MemberCard({
    member,
    me,
    canManage,
    onPassword,
}: {
    member: Member
    me: SessionUser | null
    canManage: boolean
    onPassword: () => void
}) {
    const queryClient = useQueryClient()
    const isMe = member.id === me?.id
    // Admins manage everyone but the owner and themselves; those two rows carry their own
    // controls instead.
    const managed = canManage && !isMe && member.role !== 'owner'

    const change = useMutation({
        mutationFn: (action: () => Promise<unknown>) => action(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['team'] })
            if (isMe) queryClient.invalidateQueries({ queryKey: ['session'] })
        },
        onError: explain,
    })

    const changeEmail = async () => {
        const next = await prompt({
            title: 'Change email',
            message: 'The address you sign in with.',
            default: member.email,
        })
        if (next === null || next.trim().toLowerCase() === member.email) return
        change.mutate(() => setMemberEmail(member.id, next))
    }

    const act = async (key: string) => {
        if (key === 'role') {
            change.mutate(() =>
                setMemberRole(member.id, member.role === 'admin' ? 'member' : 'admin')
            )
        } else if (key === 'password') {
            onPassword()
        } else if (key === 'remove') {
            const sure = await ask(`Remove ${member.email}? They are signed out at once.`, {
                title: 'Remove member',
                kind: 'warning',
            })
            if (sure) change.mutate(() => removeMember(member.id))
        }
    }

    return (
        <li>
            <Card shadow="sm">
                <CardBody className="flex flex-row items-center gap-3 px-4 py-3">
                    <div className="flex flex-col flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{member.email}</span>
                            {isMe && (
                                <Chip size="sm" variant="flat">
                                    You
                                </Chip>
                            )}
                        </div>
                        <span className="text-xs text-default-500">
                            Since {new Date(member.createdAt).toLocaleDateString()}
                        </span>
                    </div>
                    <Chip size="sm" variant="flat" color={ROLE_COLOR[member.role]}>
                        {ROLE_LABEL[member.role]}
                    </Chip>
                    {isMe && (
                        <>
                            <Button size="sm" variant="light" onPress={changeEmail}>
                                Change email
                            </Button>
                            <Button size="sm" variant="light" onPress={onPassword}>
                                Change password
                            </Button>
                        </>
                    )}
                    {managed && (
                        <Dropdown>
                            <DropdownTrigger>
                                <Button
                                    isIconOnly={true}
                                    size="sm"
                                    variant="light"
                                    aria-label={`Actions for ${member.email}`}
                                >
                                    <MoreHorizontalIcon className="w-4 h-4" />
                                </Button>
                            </DropdownTrigger>
                            <DropdownMenu
                                aria-label={`Actions for ${member.email}`}
                                onAction={(key) => act(String(key))}
                            >
                                <DropdownItem key="role">
                                    {member.role === 'admin' ? 'Make member' : 'Make admin'}
                                </DropdownItem>
                                <DropdownItem key="password">Reset password</DropdownItem>
                                <DropdownItem key="remove" color="danger" className="text-danger">
                                    Remove
                                </DropdownItem>
                            </DropdownMenu>
                        </Dropdown>
                    )}
                </CardBody>
            </Card>
        </li>
    )
}

// Your own password (asks for the current one) or a reset by an admin (does not; the member
// is signed out everywhere).
function PasswordModal({
    member,
    isOwn,
    onClose,
}: {
    member: Member | null
    isOwn: boolean
    onClose: () => void
}) {
    const [current, setCurrent] = useState('')
    const [next, setNext] = useState('')
    const [confirm, setConfirm] = useState('')
    const reset = () => {
        setCurrent('')
        setNext('')
        setConfirm('')
    }
    const close = () => {
        reset()
        onClose()
    }

    const save = useMutation({
        mutationFn: async () => {
            if (!member) return
            if (next !== confirm) throw new Error('The new passwords do not match.')
            await setMemberPassword(member.id, next, isOwn ? current : undefined)
        },
        onSuccess: close,
        onError: explain,
    })

    return (
        <Modal isOpen={member !== null} onClose={close} placement="center">
            <ModalContent>
                <ModalHeader>
                    {isOwn ? 'Change your password' : `Reset the password of ${member?.email}`}
                </ModalHeader>
                <ModalBody>
                    {isOwn && (
                        <Input
                            type="password"
                            label="Current password"
                            autoComplete="current-password"
                            value={current}
                            onValueChange={setCurrent}
                        />
                    )}
                    <Input
                        type="password"
                        label="New password"
                        description="At least 8 characters."
                        autoComplete="new-password"
                        value={next}
                        onValueChange={setNext}
                    />
                    <Input
                        type="password"
                        label="Confirm new password"
                        autoComplete="new-password"
                        value={confirm}
                        onValueChange={setConfirm}
                    />
                </ModalBody>
                <ModalFooter>
                    <Button variant="light" onPress={close} data-focus-visible="false">
                        Cancel
                    </Button>
                    <Button
                        color="primary"
                        isLoading={save.isPending}
                        isDisabled={!next || (isOwn && !current)}
                        onPress={() => save.mutate()}
                        data-focus-visible="false"
                    >
                        Save
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    )
}
