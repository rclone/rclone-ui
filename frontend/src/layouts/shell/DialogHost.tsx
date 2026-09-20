import {
    Button,
    Input,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@heroui/react'
import { useEffect, useRef, useState } from 'react'
import { writeText } from '@/clipboard'
import { type DialogRequest, settle, subscribe } from '@/dialog'
import PathSelector from '@/components/PathSelector'

// Renders the head of the dialog queue (src/dialog.ts): the in-page message / ask /
// prompt / open / save dialogs.
export default function DialogHost() {
    const [queue, setQueue] = useState<DialogRequest[]>([])
    useEffect(() => subscribe(setQueue), [])
    const head = queue[0]
    // Settling a request answers its promise at once, but the dialog has to stay on screen to
    // animate shut — so what is shown outlives the queue entry, and `key` counts openings so a
    // new dialog is a fresh mount while the leaving one is not remounted.
    const [shown, setShown] = useState<{ request: DialogRequest; key: number } | null>(null)
    const openings = useRef(0)
    useEffect(() => {
        if (!head) return
        openings.current += 1
        setShown({ request: head, key: openings.current })
    }, [head])
    if (!shown) return null

    const { request, key } = shown
    const isOpen = !!head
    const done = () => settle(request)
    switch (request.kind) {
        case 'message':
            return <MessageDialog key={key} isOpen={isOpen} request={request} done={done} />
        case 'prompt':
            return <PromptDialog key={key} isOpen={isOpen} request={request} done={done} />
        case 'handoff':
            return <HandoffDialog key={key} isOpen={isOpen} request={request} done={done} />
        case 'open':
            return <OpenDialog key={key} isOpen={isOpen} request={request} done={done} />
        case 'save':
            return <SaveDialog key={key} isOpen={isOpen} request={request} done={done} />
    }
}

const LEVEL_COLOR = { info: 'primary', warning: 'warning', error: 'danger' } as const

function MessageDialog({
    isOpen,
    request,
    done,
}: { isOpen: boolean; request: Extract<DialogRequest, { kind: 'message' }>; done: () => void }) {
    const finish = (label: string) => {
        request.resolve(label)
        done()
    }
    const cancelLabel = request.buttons.cancel
    return (
        <Modal
            isOpen={isOpen}
            onClose={() => finish(cancelLabel ?? request.buttons.ok)}
            // Four buttons do not fit the medium width: the last two lose their ends.
            size={request.buttons.second ? 'lg' : 'md'}
            placement="center"
        >
            <ModalContent>
                <ModalHeader>{request.title ?? 'Rclone Cloud'}</ModalHeader>
                <ModalBody>
                    <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                        {request.message}
                    </p>
                </ModalBody>
                {/* Wraps rather than clips, whatever the labels turn out to be. */}
                <ModalFooter className="flex-wrap">
                    {cancelLabel && (
                        <Button variant="light" onPress={() => finish(cancelLabel)}>
                            {cancelLabel}
                        </Button>
                    )}
                    {request.buttons.extra && (
                        <Button variant="flat" onPress={() => finish(request.buttons.extra!)}>
                            {request.buttons.extra}
                        </Button>
                    )}
                    {request.buttons.second && (
                        <Button variant="flat" onPress={() => finish(request.buttons.second!)}>
                            {request.buttons.second}
                        </Button>
                    )}
                    <Button
                        color={LEVEL_COLOR[request.level ?? 'info']}
                        onPress={() => finish(request.buttons.ok)}
                    >
                        {request.buttons.ok}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    )
}

function PromptDialog({
    isOpen,
    request,
    done,
}: { isOpen: boolean; request: Extract<DialogRequest, { kind: 'prompt' }>; done: () => void }) {
    const [value, setValue] = useState(request.defaultValue)
    const finish = (result: string | null) => {
        request.resolve(result)
        done()
    }
    return (
        <Modal isOpen={isOpen} onClose={() => finish(null)} size="md" placement="center">
            <ModalContent>
                <form
                    onSubmit={(e) => {
                        e.preventDefault()
                        finish(value)
                    }}
                >
                    <ModalHeader>{request.title}</ModalHeader>
                    <ModalBody>
                        {request.message && (
                            <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                                {request.message}
                            </p>
                        )}
                        <Input
                            autoFocus={true}
                            type={request.sensitive ? 'password' : 'text'}
                            value={value}
                            onValueChange={setValue}
                            size="sm"
                        />
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="light" onPress={() => finish(null)}>
                            Cancel
                        </Button>
                        <Button color="primary" type="submit">
                            OK
                        </Button>
                    </ModalFooter>
                </form>
            </ModalContent>
        </Modal>
    )
}

function HandoffDialog({
    isOpen,
    request,
    done,
}: { isOpen: boolean; request: Extract<DialogRequest, { kind: 'handoff' }>; done: () => void }) {
    const [value, setValue] = useState('')
    const [copied, setCopied] = useState(false)
    const finish = (result: string | null) => {
        request.resolve(result)
        done()
    }
    return (
        <Modal isOpen={isOpen} onClose={() => finish(null)} size="lg" placement="center">
            <ModalContent>
                <form
                    onSubmit={(e) => {
                        e.preventDefault()
                        if (value.trim()) finish(value.trim())
                    }}
                >
                    <ModalHeader>{request.title}</ModalHeader>
                    <ModalBody>
                        <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                            {request.message}
                        </p>
                        {/* The link stays on screen while the answer is pasted: it is needed on
                            the other machine, and a copy that silently failed leaves nothing. */}
                        <Input
                            label={request.linkLabel}
                            labelPlacement="outside"
                            value={request.link}
                            isReadOnly={true}
                            size="sm"
                            onFocus={(e) => (e.target as HTMLInputElement).select()}
                            endContent={
                                <Button
                                    size="sm"
                                    variant="flat"
                                    onPress={async () => {
                                        await writeText(request.link)
                                        setCopied(true)
                                    }}
                                >
                                    {copied ? 'Copied' : 'Copy'}
                                </Button>
                            }
                        />
                        <Input
                            autoFocus={true}
                            label={request.inputLabel}
                            labelPlacement="outside"
                            value={value}
                            onValueChange={setValue}
                            size="sm"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck="false"
                        />
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="light" onPress={() => finish(null)}>
                            Cancel
                        </Button>
                        <Button color="primary" type="submit" isDisabled={!value.trim()}>
                            {request.confirmLabel}
                        </Button>
                    </ModalFooter>
                </form>
            </ModalContent>
        </Modal>
    )
}

function OpenDialog({
    isOpen,
    request,
    done,
}: { isOpen: boolean; request: Extract<DialogRequest, { kind: 'open' }>; done: () => void }) {
    return (
        <PathSelector
            isOpen={isOpen}
            allowedKeys={['LOCAL_FS', 'LOCAL_FS_EXTRA']}
            mode={request.directory ? 'folders' : 'files'}
            allowMultiple={request.multiple}
            initialPaths={request.defaultPath ? [request.defaultPath] : []}
            onClose={() => {
                request.resolve(null)
                done()
            }}
            onSelect={(items) => {
                const paths = items.map((item) => item.path)
                request.resolve(request.multiple ? paths : (paths[0] ?? null))
                done()
            }}
        />
    )
}

function SaveDialog({
    isOpen,
    request,
    done,
}: { isOpen: boolean; request: Extract<DialogRequest, { kind: 'save' }>; done: () => void }) {
    const defaultName = request.defaultPath?.split(/[\\/]/).pop() ?? ''
    const [folder, setFolder] = useState<string | null>(null)
    const [name, setName] = useState(defaultName)
    if (!folder) {
        return (
            <PathSelector
                isOpen={isOpen}
                allowedKeys={['LOCAL_FS', 'LOCAL_FS_EXTRA']}
                mode="folders"
                allowMultiple={false}
                onClose={() => {
                    request.resolve(null)
                    done()
                }}
                onSelect={(items) => setFolder(items[0]?.path ?? null)}
            />
        )
    }
    const separator = folder.includes('\\') ? '\\' : '/'
    const finish = (result: string | null) => {
        request.resolve(result)
        done()
    }
    return (
        <Modal isOpen={isOpen} onClose={() => finish(null)} size="md" placement="center">
            <ModalContent>
                <form
                    onSubmit={(e) => {
                        e.preventDefault()
                        if (name.trim())
                            finish(`${folder.replace(/[\\/]+$/, '')}${separator}${name.trim()}`)
                    }}
                >
                    <ModalHeader>{request.title ?? 'Save as'}</ModalHeader>
                    <ModalBody>
                        <p className="text-sm text-default-500">{folder}</p>
                        <Input
                            autoFocus={true}
                            label="File name"
                            value={name}
                            onValueChange={setName}
                            size="sm"
                        />
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="light" onPress={() => finish(null)}>
                            Cancel
                        </Button>
                        <Button color="primary" type="submit" isDisabled={!name.trim()}>
                            Save
                        </Button>
                    </ModalFooter>
                </form>
            </ModalContent>
        </Modal>
    )
}
