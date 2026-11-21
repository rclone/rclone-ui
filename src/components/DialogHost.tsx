import {
    Button,
    cn,
    Input,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@heroui/react'
import { Trans } from '@lingui/react/macro'
import {
    ExclamationTriangle as ExclamationTriangleIcon,
    Gear as GearIcon,
    InfoCircle as InfoCircleIcon,
    LockSimple as LockSimpleIcon,
    PenLine as PenLineIcon,
    Trash as TrashIcon,
    XmarkCircle as XmarkCircleIcon,
} from '@zappicon/react'
import { type ComponentType, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Option } from '../../lib/catalog'
import { currentWindow, scriptedAnswer } from '../../lib/shell'
import { type DialogKind, type DialogRequest, settle, subscribe } from '../../lib/shell/dialog'
import RemoteField, { type RemoteValues } from '../pages/Remotes/RemoteField'
import { toneButton } from './look/buttons'
import { IconTile } from './look/IconTile'
import type { Tone } from './look/tones'
import { answerOf, initialAnswer } from './optionDialog'

/**
 * Shows the dialogs that message, ask, prompt and askOption in lib/shell queue, one at a time and
 * in order. main.tsx mounts it once in every window, outside the router, so it works even when the
 * page has crashed.
 */
export default function DialogHost() {
    const [queue, setQueue] = useState<DialogRequest[]>([])
    useEffect(() => subscribe(setQueue), [])
    const head = queue[0]
    // Answering a request resolves its promise at once, but the dialog stays on screen while it
    // animates shut. `key` counts the openings, so only a new dialog mounts afresh.
    const [shown, setShown] = useState<{ request: DialogRequest; key: number } | null>(null)
    const openings = useRef(0)
    useEffect(() => {
        if (!head) return
        openings.current += 1
        setShown({ request: head, key: openings.current })
        // A dialog in a window behind other windows would go unseen, so the window comes to the
        // front.
        currentWindow
            .isFocused()
            .then((focused) => (focused ? undefined : currentWindow.focus()))
            .catch(() => undefined)
    }, [head])
    if (!shown) return null

    const { request, key } = shown
    const isOpen = !!head && head === request
    const done = () => settle(request)
    if (request.type === 'message') {
        return <MessageDialog key={key} isOpen={isOpen} request={request} done={done} />
    }
    if (request.type === 'option') {
        return <OptionDialog key={key} isOpen={isOpen} request={request} done={done} />
    }
    return <PromptDialog key={key} isOpen={isOpen} request={request} done={done} />
}

const LEVEL_COLOR = { info: 'primary', warning: 'warning', error: 'danger' } as const

type Look = { icon: ComponentType<{ className?: string }>; tone: Tone }

const LEVEL_LOOK: Record<DialogKind | 'destructive', Look> = {
    info: { icon: InfoCircleIcon, tone: 'blue' },
    warning: { icon: ExclamationTriangleIcon, tone: 'orange' },
    error: { icon: XmarkCircleIcon, tone: 'red' },
    destructive: { icon: TrashIcon, tone: 'red' },
}

/**
 * Whether a warning asks to delete or discard something ("Delete remote", "Discard the waiting
 * uploads?"). Those dialogs are drawn in red. The caller sets `destructive`, because the text is
 * translated and can't be checked here.
 */
function isDestructive(request: Extract<DialogRequest, { type: 'message' }>): boolean {
    return request.kind === 'warning' && !!request.buttons.cancel && !!request.destructive
}

function DialogLayout({
    look,
    title,
    children,
    footer,
}: {
    look: Look
    title: string
    children?: ReactNode
    footer: ReactNode
}) {
    return (
        <>
            <div className="flex flex-1 min-h-0 gap-4 px-6 pt-6 pb-3">
                <IconTile icon={look.icon} tone={look.tone} size="lg" className="mt-0.5" />
                <div className="flex flex-col flex-1 min-w-0 min-h-0 gap-1.5">
                    <ModalHeader className="p-0 text-[15px] font-semibold leading-snug text-balance">
                        {title}
                    </ModalHeader>
                    <ModalBody className="gap-3 p-0 pb-1">{children}</ModalBody>
                </div>
            </div>
            <ModalFooter className="flex-wrap gap-2 px-6 pt-3 pb-5">{footer}</ModalFooter>
        </>
    )
}

const MESSAGE =
    'whitespace-pre-wrap text-small leading-relaxed text-default-600 [overflow-wrap:anywhere]'

// Each request asks for its scripted answer once, because each asking takes a line from the
// answers file. StrictMode runs effects twice in development.
const scripted = new WeakMap<DialogRequest, Promise<string | null>>()

/**
 * In a development run that a script drives, answers the dialog with the script's next answer
 * (see scriptedAnswer). With no answer, the dialog waits, and a script can press its buttons.
 */
function useScriptedAnswer(
    request: DialogRequest,
    isOpen: boolean,
    answer: (line: string) => void
) {
    const answerRef = useRef(answer)
    answerRef.current = answer
    useEffect(() => {
        if (!isOpen) return
        let live = true
        let answer = scripted.get(request)
        if (!answer) {
            answer = scriptedAnswer(request.title, request.message, request.type !== 'message')
            scripted.set(request, answer)
        }
        answer.then((line) => {
            if (live && line !== null) answerRef.current(line)
        })
        return () => {
            live = false
        }
    }, [request, isOpen])
}

function MessageDialog({
    isOpen,
    request,
    done,
}: {
    isOpen: boolean
    request: Extract<DialogRequest, { type: 'message' }>
    done: () => void
}) {
    const { ok, cancel, extra } = request.buttons
    const destructive = isDestructive(request)
    const finish = (label: string) => {
        request.resolve(label)
        done()
    }
    // OK is the default button: Enter chooses it, as in the OS's dialogs, unless another button
    // has the focus. The modal focuses itself when it opens, so OK can't simply take the focus.
    const finishRef = useRef(finish)
    finishRef.current = finish
    useEffect(() => {
        if (!isOpen) return
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return
            if ((e.target as Element | null)?.closest('button, a, input, textarea, select')) return
            e.preventDefault()
            finishRef.current(ok)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [isOpen, ok])
    useScriptedAnswer(request, isOpen, (line) => {
        if (line === 'ok' || line.startsWith('text:')) finish(ok)
        else if (line === 'extra' && extra) finish(extra)
        else finish(cancel ?? ok)
    })
    return (
        <Modal
            isOpen={isOpen}
            onClose={() => finish(cancel ?? ok)}
            isDismissable={false}
            size="md"
            placement="center"
            scrollBehavior="inside"
        >
            <ModalContent>
                <DialogLayout
                    look={LEVEL_LOOK[destructive ? 'destructive' : request.kind]}
                    title={request.title}
                    footer={
                        <>
                            {extra && (
                                <Button
                                    variant="light"
                                    className="mr-auto"
                                    onPress={() => finish(extra)}
                                >
                                    {extra}
                                </Button>
                            )}
                            {cancel && (
                                <Button variant="flat" onPress={() => finish(cancel)}>
                                    {cancel}
                                </Button>
                            )}
                            <Button
                                color={destructive ? 'danger' : LEVEL_COLOR[request.kind]}
                                className={toneButton(
                                    LEVEL_LOOK[destructive ? 'destructive' : request.kind].tone
                                )}
                                onPress={() => finish(ok)}
                            >
                                {ok}
                            </Button>
                        </>
                    }
                >
                    <p className={MESSAGE}>{request.message}</p>
                </DialogLayout>
            </ModalContent>
        </Modal>
    )
}

function PromptDialog({
    isOpen,
    request,
    done,
}: {
    isOpen: boolean
    request: Extract<DialogRequest, { type: 'prompt' }>
    done: () => void
}) {
    const [value, setValue] = useState(request.defaultValue)
    const finish = (result: string | null) => {
        request.resolve(result)
        done()
    }
    useScriptedAnswer(request, isOpen, (line) => {
        if (line.startsWith('text:')) finish(line.slice('text:'.length))
        else if (line === 'ok') finish(request.defaultValue)
        else finish(null)
    })
    return (
        <Modal
            isOpen={isOpen}
            onClose={() => finish(null)}
            isDismissable={false}
            size="md"
            placement="center"
        >
            <ModalContent>
                <form
                    className="flex flex-col min-h-0"
                    onSubmit={(e) => {
                        e.preventDefault()
                        finish(value)
                    }}
                >
                    <DialogLayout
                        look={
                            request.sensitive
                                ? { icon: LockSimpleIcon, tone: 'graphite' }
                                : { icon: PenLineIcon, tone: 'blue' }
                        }
                        title={request.title}
                        footer={
                            <>
                                <Button variant="flat" onPress={() => finish(null)}>
                                    <Trans>Cancel</Trans>
                                </Button>
                                <Button
                                    color="primary"
                                    type="submit"
                                    className={toneButton('blue')}
                                >
                                    <Trans>OK</Trans>
                                </Button>
                            </>
                        }
                    >
                        {request.message && <p className={MESSAGE}>{request.message}</p>}
                        <Input
                            autoFocus={true}
                            aria-label={request.title}
                            type={request.sensitive ? 'password' : 'text'}
                            value={value}
                            onValueChange={setValue}
                            onFocus={(e) => e.target.select()}
                            size="sm"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck="false"
                            classNames={{ inputWrapper: 'h-9', input: 'text-sm' }}
                        />
                    </DialogLayout>
                </form>
            </ModalContent>
        </Modal>
    )
}

/** Asks one of rclone's config questions (askOption) with the field that the remote forms use. */
function OptionDialog({
    isOpen,
    request,
    done,
}: {
    isOpen: boolean
    request: Extract<DialogRequest, { type: 'option' }>
    done: () => void
}) {
    const { option } = request
    // The help is shown as the question, so the field drops it rather than repeat it. A question
    // is always shown, even for an option that the remote forms hide.
    const field = useMemo(() => new Option({ ...option, help: '', hidden: false }), [option])
    const [values, setValues] = useState<RemoteValues>(() => ({
        [option.name]: initialAnswer(option),
    }))
    const finish = (result: string | null) => {
        request.resolve(result)
        done()
    }
    const answer = () => answerOf(option, values[option.name])
    useScriptedAnswer(request, isOpen, (line) => {
        if (line.startsWith('text:')) finish(line.slice('text:'.length))
        else if (line === 'ok') finish(answer())
        else finish(null)
    })
    return (
        <Modal
            isOpen={isOpen}
            onClose={() => finish(null)}
            isDismissable={false}
            size="md"
            placement="center"
            scrollBehavior="inside"
        >
            <ModalContent>
                <form
                    className="flex flex-col min-h-0"
                    onSubmit={(e) => {
                        e.preventDefault()
                        finish(answer())
                    }}
                >
                    <DialogLayout
                        look={
                            option.password || option.sensitive
                                ? { icon: LockSimpleIcon, tone: 'graphite' }
                                : { icon: GearIcon, tone: 'blue' }
                        }
                        title={request.title}
                        footer={
                            <>
                                <Button variant="flat" onPress={() => finish(null)}>
                                    <Trans>Cancel</Trans>
                                </Button>
                                <Button
                                    color="primary"
                                    type="submit"
                                    className={toneButton('blue')}
                                >
                                    <Trans>OK</Trans>
                                </Button>
                            </>
                        }
                    >
                        {request.notice && (
                            <p className={cn(MESSAGE, 'text-danger')}>{request.notice}</p>
                        )}
                        <p className={MESSAGE}>{request.message}</p>
                        <RemoteField option={field} config={values} setConfig={setValues} />
                    </DialogLayout>
                </form>
            </ModalContent>
        </Modal>
    )
}
