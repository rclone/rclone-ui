import {
    Button,
    cn,
    Input,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
    Radio,
    RadioGroup,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
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
import {
    type ComponentType,
    type ReactNode,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from 'react'
import { Option } from '../../lib/catalog'
import { currentWindow, scriptedAnswer } from '../../lib/shell'
import { type DialogKind, type DialogRequest, settle, subscribe } from '../../lib/shell/dialog'
import RemoteField, { type RemoteValues } from '../pages/Remotes/RemoteField'
import { toneButton } from './look/buttons'
import { IconTile } from './look/IconTile'
import type { Tone } from './look/tones'
import {
    answerOf,
    initialAnswer,
    initialPick,
    isChoiceQuestion,
    OTHER_VALUE,
    pickedAnswer,
    takesOtherValue,
} from './optionDialog'

export default function DialogHost() {
    const [queue, setQueue] = useState<DialogRequest[]>([])
    useEffect(() => subscribe(setQueue), [])
    const head = queue[0]
    const [shown, setShown] = useState<{ request: DialogRequest; key: number } | null>(null)
    const openings = useRef(0)
    useEffect(() => {
        if (!head) return
        openings.current += 1
        setShown({ request: head, key: openings.current })
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

const scripted = new WeakMap<DialogRequest, Promise<string | null>>()

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
    const field = useMemo(() => new Option({ ...option, help: '', hidden: false }), [option])
    const [values, setValues] = useState<RemoteValues>(() => ({
        [option.name]: initialAnswer(option),
    }))
    const choosing = isChoiceQuestion(option)
    const [pick, setPick] = useState(() => initialPick(option).pick)
    const [typed, setTyped] = useState(() => initialPick(option).typed)
    const messageId = useId()
    const finish = (result: string | null) => {
        request.resolve(result)
        done()
    }
    const answer = () =>
        choosing ? pickedAnswer(pick, typed) : answerOf(option, values[option.name])
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
                        <p id={messageId} className={MESSAGE}>
                            {request.message}
                        </p>
                        {choosing ? (
                            <QuestionChoices
                                option={option}
                                labelledBy={messageId}
                                pick={pick}
                                setPick={setPick}
                                typed={typed}
                                setTyped={setTyped}
                            />
                        ) : (
                            <RemoteField option={field} config={values} setConfig={setValues} />
                        )}
                    </DialogLayout>
                </form>
            </ModalContent>
        </Modal>
    )
}

/** Lists a question's choices with their values, as rclone's command line does. */
function QuestionChoices({
    option,
    labelledBy,
    pick,
    setPick,
    typed,
    setTyped,
}: {
    option: Option
    labelledBy: string
    pick: string
    setPick: (pick: string) => void
    typed: string
    setTyped: (typed: string) => void
}) {
    const other = takesOtherValue(option)
    return (
        <div className="flex flex-col gap-3">
            <RadioGroup
                aria-labelledby={labelledBy}
                value={pick}
                onValueChange={setPick}
                classNames={{ wrapper: 'gap-2.5' }}
            >
                {option.choices.map((choice) => (
                    <Radio
                        key={choice.value}
                        value={choice.value}
                        description={choice.help ? choice.value || NO_VALUE : undefined}
                        classNames={{
                            label: 'text-small whitespace-pre-line',
                            description: 'font-mono text-tiny [overflow-wrap:anywhere]',
                        }}
                    >
                        {choice.help || choice.value || NO_VALUE}
                    </Radio>
                ))}
                {other && (
                    <Radio value={OTHER_VALUE} classNames={{ label: 'text-small' }}>
                        {ANOTHER_VALUE}
                    </Radio>
                )}
            </RadioGroup>
            {other && pick === OTHER_VALUE && (
                <Input
                    aria-label={ANOTHER_VALUE}
                    value={typed}
                    onValueChange={setTyped}
                    autoFocus={true}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck="false"
                    classNames={{ inputWrapper: 'h-9', input: 'text-sm' }}
                />
            )}
        </div>
    )
}

const ANOTHER_VALUE = t({
    message: 'Another value',
    comment: 'The last item in a list of choices: lets the user type a value that the list lacks.',
})

const NO_VALUE = t({
    message: 'No Value',
    comment: "An empty choice in a list of an option's values.",
})
