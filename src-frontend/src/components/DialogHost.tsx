import {
    Button,
    Input,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@heroui/react'
import { useEffect, useState } from 'react'
import { writeText } from '../../lib/api/clipboard'
import { type DialogRequest, settle, subscribe } from '../../lib/api/dialogs'
import PathSelector from './PathSelector'

// Renders the head of the dialog queue (lib/api/dialogs.ts): the in-page message / ask /
// prompt / open / save dialogs, on both products.
export default function DialogHost() {
    const [queue, setQueue] = useState<DialogRequest[]>([])
    useEffect(() => subscribe(setQueue), [])
    const request = queue[0]
    if (!request) return null

    const done = () => settle(request)
    switch (request.kind) {
        case 'message':
            return <MessageDialog key={queue.length} request={request} done={done} />
        case 'prompt':
            return <PromptDialog key={queue.length} request={request} done={done} />
        case 'handoff':
            return <HandoffDialog key={queue.length} request={request} done={done} />
        case 'open':
            return <OpenDialog key={queue.length} request={request} done={done} />
        case 'save':
            return <SaveDialog key={queue.length} request={request} done={done} />
    }
}

const LEVEL_COLOR = { info: 'primary', warning: 'warning', error: 'danger' } as const

function MessageDialog({
    request,
    done,
}: { request: Extract<DialogRequest, { kind: 'message' }>; done: () => void }) {
    const finish = (label: string) => {
        request.resolve(label)
        done()
    }
    const cancelLabel = request.buttons.cancel
    return (
        <Modal
            isOpen={true}
            onClose={() => finish(cancelLabel ?? request.buttons.ok)}
            // Four buttons do not fit the medium width: the last two lose their ends.
            size={request.buttons.second ? 'lg' : 'md'}
            placement="center"
        >
            <ModalContent>
                <ModalHeader>{request.title ?? 'Rclone UI'}</ModalHeader>
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
    request,
    done,
}: { request: Extract<DialogRequest, { kind: 'prompt' }>; done: () => void }) {
    const [value, setValue] = useState(request.defaultValue)
    const finish = (result: string | null) => {
        request.resolve(result)
        done()
    }
    return (
        <Modal isOpen={true} onClose={() => finish(null)} size="md" placement="center">
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
    request,
    done,
}: { request: Extract<DialogRequest, { kind: 'handoff' }>; done: () => void }) {
    const [value, setValue] = useState('')
    const [copied, setCopied] = useState(false)
    const finish = (result: string | null) => {
        request.resolve(result)
        done()
    }
    return (
        <Modal isOpen={true} onClose={() => finish(null)} size="lg" placement="center">
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
    request,
    done,
}: { request: Extract<DialogRequest, { kind: 'open' }>; done: () => void }) {
    return (
        <PathSelector
            isOpen={true}
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
    request,
    done,
}: { request: Extract<DialogRequest, { kind: 'save' }>; done: () => void }) {
    const defaultName = request.defaultPath?.split(/[\\/]/).pop() ?? ''
    const [folder, setFolder] = useState<string | null>(null)
    const [name, setName] = useState(defaultName)
    if (!folder) {
        return (
            <PathSelector
                isOpen={true}
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
        <Modal isOpen={true} onClose={() => finish(null)} size="md" placement="center">
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
