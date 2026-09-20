import {
    Button,
    Input,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
    Select,
    SelectItem,
} from '@heroui/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { message } from '@/dialog'
import { type MemberRole, addMember } from '@/lib/team'

interface Form {
    email: string
    password: string
    role: MemberRole
}

const EMPTY: Form = { email: '', password: '', role: 'member' }

// Settings › Team › New member: three fields, so a modal, not a drawer. The server checks the
// email's shape and uniqueness and the password's length; this only collects them.
export default function TeamMemberModal({
    isOpen,
    onClose,
}: {
    isOpen: boolean
    onClose: () => void
}) {
    const [form, setForm] = useState<Form>(EMPTY)
    const queryClient = useQueryClient()

    const close = () => {
        setForm(EMPTY)
        onClose()
    }

    const add = useMutation({
        mutationFn: () => addMember(form.email, form.password, form.role),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['team'] })
            close()
        },
        onError: (error) => {
            void message(error instanceof Error ? error.message : String(error), {
                title: 'Could not add the member',
                kind: 'error',
            })
        },
    })

    return (
        <Modal isOpen={isOpen} onClose={close} placement="center">
            <ModalContent>
                <ModalHeader>New member</ModalHeader>
                <ModalBody>
                    <Input
                        label="Email"
                        labelPlacement="outside"
                        placeholder="pat@example.com"
                        type="email"
                        value={form.email}
                        onValueChange={(email) => setForm((prev) => ({ ...prev, email }))}
                        isRequired={true}
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck="false"
                    />
                    <Input
                        label="Password"
                        labelPlacement="outside"
                        placeholder="At least 8 characters"
                        description="They can change it after signing in."
                        type="password"
                        value={form.password}
                        onValueChange={(password) => setForm((prev) => ({ ...prev, password }))}
                        isRequired={true}
                        autoComplete="new-password"
                    />
                    <Select
                        label="Role"
                        labelPlacement="outside"
                        selectedKeys={[form.role]}
                        disallowEmptySelection={true}
                        onSelectionChange={(keys) => {
                            const role = Array.from(keys)[0] as MemberRole
                            setForm((prev) => ({ ...prev, role }))
                        }}
                        description="Admins add and remove members and reset their passwords."
                        data-focus-visible="false"
                    >
                        <SelectItem key="member">Member</SelectItem>
                        <SelectItem key="admin">Admin</SelectItem>
                    </Select>
                </ModalBody>
                <ModalFooter>
                    <Button color="danger" variant="light" onPress={close} data-focus-visible="false">
                        Cancel
                    </Button>
                    <Button
                        color="primary"
                        isLoading={add.isPending}
                        isDisabled={!form.email.trim() || !form.password}
                        onPress={() => add.mutate()}
                        data-focus-visible="false"
                    >
                        Add
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    )
}
