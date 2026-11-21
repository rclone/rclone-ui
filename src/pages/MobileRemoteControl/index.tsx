import { Button, cn, Skeleton } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
    AngleDownSmall as AngleDownSmallIcon,
    Check as CheckIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    Page as PageIcon,
    TerminalSquare as TerminalSquareIcon,
} from '@zappicon/react'
import { AnimatePresence, motion, type Transition, useReducedMotion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { type ReactNode, useId, useState } from 'react'
import { formatErrorMessage } from '../../../lib/errors'
import { shellKeys } from '../../../lib/live'
import { clipboard, message, openUrl, pathLink } from '../../../lib/shell'
import { State as TunnelState } from '../../../lib/shell/bindings/github.com/rclone/rclone-ui/core/tunnel/models'
import { toneButton } from '../../components/look/buttons'
import { IconTile } from '../../components/look/IconTile'
import { Panel } from '../../components/look/Panel'
import { StatusDot, type StatusKind } from '../../components/look/Status'
import { ToneProgress } from '../../components/look/ToneProgress'
import { GLOSS, TONE_GRADIENT, TONE_RGB } from '../../components/look/tones'
import SettingsWindow from '../../components/SettingsWindow'
import { WINDOWS } from '../../routes'
import { startTunnel, stopTunnel, useTunnel } from './tunnel'

const LOOK = WINDOWS.mobileRemoteControl

const APP_STORE = 'https://apps.apple.com/app/rclone-ui/id6756127598'
const GOOGLE_PLAY = 'https://play.google.com/store/apps/details?id=com.rclone.mobile'

type Field = 'url' | 'user' | 'pass' | 'command'

/** The tunnel's state, as the page shows it. */
type Phase = 'loading' | 'unknown' | 'off' | 'failed' | 'starting' | 'restarting' | 'on'

const PHASES: Record<Phase, { label: string; kind: StatusKind }> = {
    loading: { label: t`Checking`, kind: 'idle' },
    unknown: { label: t`Unknown`, kind: 'idle' },
    off: { label: t({ message: 'Off', context: 'state of the remote tunnel' }), kind: 'idle' },
    failed: { label: t`Didn’t start`, kind: 'danger' },
    starting: { label: t`Starting`, kind: 'active' },
    restarting: { label: t`Restarting`, kind: 'active' },
    on: { label: t({ message: 'On', context: 'state of the remote tunnel' }), kind: 'success' },
}

type StepState = 'current' | 'done' | 'failed' | 'upcoming'

// The remote tunnel (core/tunnel). While it's on, the core runs `rclone tunnel` on the active
// config. This serves rclone's rc with random credentials behind a cloudflared quick tunnel. The
// QR code holds {url, user, pass}, which the mobile app reads. The same command also works in a
// terminal.
/**
 * The Mobile & Remote Control window: three steps that connect a phone (get the app, turn on the
 * tunnel, scan its code). Each step shows whether it is done.
 */
export default function MobileRemoteControl() {
    const statusQuery = useTunnel()
    const status = statusQuery.data
    const on = status?.state === TunnelState.StateOn
    const starting =
        status?.state === TunnelState.StateStarting || status?.state === TunnelState.StateRestarting
    // The tunnel can also be turned off while it is starting (for example, waiting for the
    // network) or keeps restarting.
    const canDisable = on || starting
    const cloudflaredTunnel = on ? status : undefined

    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState<Field | null>(null)
    const link = useQuery({
        queryKey: shellKeys.pathLink,
        queryFn: () => pathLink.status(),
    }).data
    const command = link?.command ? `${link.command} tunnel` : undefined

    const handleCopy = async (field: Field, value: string) => {
        await clipboard.setText(value)
        setCopied(field)
        setTimeout(() => setCopied(null), 2000)
    }

    const startTunnelMutation = useMutation({
        mutationFn: async () => {
            setError(null)
            await startTunnel()
        },
        onError: async (e) => {
            const errorMsg = formatErrorMessage(e)
            setError(errorMsg)
            await message(t`Failed to start tunnel: ${errorMsg}`, {
                title: t`Error`,
                kind: 'error',
            })
        },
    })

    const stopTunnelMutation = useMutation({
        mutationFn: stopTunnel,
        onError: async (e) => {
            const errorMsg = formatErrorMessage(e)
            await message(t`Failed to stop tunnel: ${errorMsg}`, {
                title: t`Error`,
                kind: 'error',
            })
        },
    })

    const failure = cloudflaredTunnel ? null : error || status?.error || null
    const phase: Phase = statusQuery.isLoading
        ? 'loading'
        : on
          ? 'on'
          : status?.state === TunnelState.StateRestarting
            ? 'restarting'
            : status?.state === TunnelState.StateStarting
              ? 'starting'
              : failure
                ? 'failed'
                : statusQuery.isError
                  ? 'unknown'
                  : 'off'
    const enabling = startTunnelMutation.isPending || starting
    const enable = () => startTunnelMutation.mutate()

    const reduceMotion = useReducedMotion()
    const swap: Transition = reduceMotion
        ? { duration: 0 }
        : { type: 'spring', bounce: 0, duration: 0.35 }

    return (
        <SettingsWindow
            look={LOOK}
            title={t`Remote Control`}
            description={t`Use rclone from your phone, through a private tunnel to this computer.`}
            actions={
                <>
                    <TunnelStatus phase={phase} />
                    {!cloudflaredTunnel && !starting && (
                        <Button
                            color="primary"
                            className={toneButton(LOOK.tone)}
                            onPress={enable}
                            isLoading={startTunnelMutation.isPending}
                            data-focus-visible="false"
                        >
                            {startTunnelMutation.isPending ? t`Initializing…` : t`Tap to enable`}
                        </Button>
                    )}
                    {canDisable && (
                        <Button
                            color="danger"
                            variant="flat"
                            onPress={() => stopTunnelMutation.mutate()}
                            isLoading={stopTunnelMutation.isPending}
                            data-focus-visible="false"
                        >
                            <Trans comment="Button: turns the remote tunnel off.">Disable</Trans>
                        </Button>
                    )}
                </>
            }
        >
            <div className="flex flex-col gap-8 pt-2 min-[720px]:pr-[316px]">
                {statusQuery.isError && (
                    <Problem
                        title={t`Couldn’t read the tunnel’s status`}
                        action={
                            <Button
                                size="sm"
                                variant="flat"
                                isLoading={statusQuery.isFetching}
                                onPress={() => statusQuery.refetch()}
                                data-focus-visible="false"
                            >
                                <Trans>Retry</Trans>
                            </Button>
                        }
                    >
                        {formatErrorMessage(statusQuery.error)}
                    </Problem>
                )}

                <ol aria-label={t`Set up the app on your phone`} className="flex flex-col">
                    <Step
                        n={1}
                        state={on || starting ? 'done' : 'current'}
                        title={t`Get the app`}
                        description={t`Rclone UI for iPhone and Android connects to this computer, so you can use rclone from your phone.`}
                    >
                        <div className="flex flex-wrap gap-2.5">
                            <StoreButton store="apple" onPress={() => openUrl(APP_STORE)} />
                            <StoreButton store="google" onPress={() => openUrl(GOOGLE_PLAY)} />
                        </div>
                    </Step>

                    <Step
                        n={2}
                        state={on ? 'done' : phase === 'failed' ? 'failed' : 'current'}
                        title={t`Turn on the tunnel`}
                        description={t`Rclone UI opens a private Cloudflare tunnel to rclone on this computer, with a new user and password each time.`}
                    >
                        <TunnelDetail
                            phase={phase}
                            url={cloudflaredTunnel?.url}
                            failure={failure}
                            restartError={phase === 'restarting' ? status?.error : undefined}
                            onRetry={enable}
                            retrying={enabling}
                        />
                    </Step>

                    <Step
                        n={3}
                        last={true}
                        state={on ? 'current' : 'upcoming'}
                        title={t`Scan the QR code`}
                        description={t`Scan it with Rclone UI on your phone to connect.`}
                    >
                        {phase === 'loading' ? (
                            <Skeleton className="w-full h-24 rounded-2xl" />
                        ) : (
                            <AnimatePresence initial={false} mode="wait">
                                {cloudflaredTunnel ? (
                                    <motion.div
                                        key="on"
                                        initial={{ opacity: 0, y: 6 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -4 }}
                                        transition={swap}
                                        className="flex flex-col gap-3"
                                    >
                                        <Connection
                                            url={cloudflaredTunnel.url}
                                            user={cloudflaredTunnel.user}
                                            pass={cloudflaredTunnel.pass}
                                            copied={copied}
                                            onCopy={handleCopy}
                                        />
                                        <p className="px-1 text-xs leading-relaxed text-default-500 text-pretty">
                                            <Trans>
                                                What the phone starts (transfers, mounts, serves)
                                                runs in the tunnel's own Rclone. It isn't listed
                                                here, and it ends when the tunnel does.
                                            </Trans>
                                        </p>
                                    </motion.div>
                                ) : (
                                    <motion.div
                                        key="off"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={swap}
                                    >
                                        <QrPlaceholder />
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        )}
                    </Step>
                </ol>

                {command && (
                    <Terminal
                        command={command}
                        copied={copied === 'command'}
                        onCopy={() => handleCopy('command', command)}
                        pathHint={!!link?.supported && link.command !== 'rclone'}
                    />
                )}
            </div>

            <Phone />
        </SettingsWindow>
    )
}

function TunnelStatus({ phase }: { phase: Phase }) {
    if (phase === 'loading') {
        return <Skeleton className="w-20 h-8 rounded-full" />
    }
    const { label, kind } = PHASES[phase]
    return (
        <span
            role="status"
            className="flex items-center h-8 gap-2 px-3 font-medium rounded-full text-small text-default-700 bg-default-100 dark:bg-default-100/70"
        >
            <StatusDot kind={kind} />
            <span>
                <span className="sr-only">
                    <Trans>Tunnel:</Trans>{' '}
                </span>
                {label}
            </span>
        </span>
    )
}

function Step({
    n,
    state,
    title,
    description,
    last,
    children,
}: {
    n: number
    state: StepState
    title: string
    description: string
    last?: boolean
    children: ReactNode
}) {
    return (
        <li className={cn('relative flex gap-4', !last && 'pb-8')}>
            {!last && (
                <span
                    aria-hidden={true}
                    className={cn(
                        'absolute left-4 top-10 bottom-2 w-0.5 -translate-x-1/2 rounded-full',
                        state === 'done' ? 'bg-success/45' : 'bg-default-200'
                    )}
                />
            )}
            <StepBadge n={n} state={state} />
            <div className="flex flex-col flex-1 min-w-0 gap-3.5">
                <div className="flex flex-col gap-1 pt-1">
                    <h3 className="text-[15px] font-semibold leading-tight">
                        <span className="sr-only">{stepWords(n, state)} </span>
                        {title}
                    </h3>
                    <p className="leading-snug text-small text-default-500 text-pretty">
                        {description}
                    </p>
                </div>
                {children}
            </div>
        </li>
    )
}

/** What a screen reader says before a step's title. */
function stepWords(n: number, state: StepState): string {
    switch (state) {
        case 'done':
            return t`Step ${n}, done:`
        case 'failed':
            return t`Step ${n}, failed:`
        case 'upcoming':
            return t`Step ${n}, not yet:`
        default:
            return t`Step ${n}, to do:`
    }
}

function StepBadge({ n, state }: { n: number; state: StepState }) {
    const filled = state !== 'upcoming'
    return (
        <span
            aria-hidden={true}
            className={cn(
                'relative grid place-items-center size-8 shrink-0 rounded-full text-small font-semibold tabular-nums',
                filled && cn('bg-linear-to-b text-white', GLOSS),
                state === 'current' && TONE_GRADIENT.indigo,
                state === 'done' && TONE_GRADIENT.green,
                state === 'failed' && TONE_GRADIENT.red,
                !filled &&
                    'bg-content1 text-default-500 ring-1 ring-inset ring-default-300 dark:ring-default-200'
            )}
        >
            {state === 'done' ? (
                <CheckIcon className="size-4" />
            ) : state === 'failed' ? (
                <span>!</span>
            ) : (
                n
            )}
        </span>
    )
}

function TunnelDetail({
    phase,
    url,
    failure,
    restartError,
    onRetry,
    retrying,
}: {
    phase: Phase
    url?: string
    failure: string | null
    restartError?: string
    onRetry: () => void
    retrying: boolean
}) {
    if (phase === 'loading') {
        return <Skeleton className="w-56 h-4 rounded-md" />
    }
    if (phase === 'failed') {
        return (
            <Problem
                title={t`The tunnel didn’t start`}
                action={
                    <Button
                        size="sm"
                        variant="flat"
                        onPress={onRetry}
                        isLoading={retrying}
                        data-focus-visible="false"
                    >
                        <Trans>Try again</Trans>
                    </Button>
                }
            >
                <span className="block font-mono text-xs [overflow-wrap:anywhere]">{failure}</span>
                <span className="block mt-1.5">
                    <Trans>Check that this computer is online, then try again.</Trans>
                </span>
            </Problem>
        )
    }
    if (phase === 'starting' || phase === 'restarting') {
        return (
            <div className="flex flex-col gap-2 max-w-80">
                <ToneProgress tone="indigo" label={t`Starting the tunnel`} />
                <p className="text-xs text-default-500">
                    {phase === 'restarting'
                        ? t`The tunnel stopped, and Rclone UI is starting it again…`
                        : t`Starting the tunnel. This takes a few seconds…`}
                </p>
                {restartError && (
                    <p className="text-xs text-warning-600 dark:text-warning [overflow-wrap:anywhere]">
                        {restartError}
                    </p>
                )}
            </div>
        )
    }
    if (phase === 'on') {
        const host = hostOf(url)
        return (
            <p className="flex items-center min-w-0 gap-2 text-small">
                <StatusDot kind="success" />
                <span className="min-w-0 truncate">
                    <Trans>
                        On at{' '}
                        <span className="font-mono text-default-600" title={url}>
                            {host}
                        </span>
                    </Trans>
                </span>
            </p>
        )
    }
    return (
        <p className="flex items-center gap-2 text-small text-default-600">
            <StatusDot kind="idle" />
            {phase === 'unknown'
                ? t`Press Tap to enable, at the top, to start it.`
                : t`The tunnel is off. Press Tap to enable, at the top, to start it.`}
        </p>
    )
}

function Connection({
    url,
    user,
    pass,
    copied,
    onCopy,
}: {
    url: string
    user: string
    pass: string
    copied: Field | null
    onCopy: (field: Field, value: string) => void
}) {
    const rows = [
        ['url', t`URL`, t`Copy the URL`, url],
        ['user', t`User`, t`Copy the user`, user],
        ['pass', t`Password`, t`Copy the password`, pass],
    ] as const
    return (
        <Panel className="flex flex-col divide-y divide-divider">
            <div className="flex items-center gap-5 p-4">
                <div className="p-2.5 bg-white rounded-xl shrink-0 shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_4px_12px_-4px_rgb(0_0_0/0.2)]">
                    <QRCodeSVG value={JSON.stringify({ url, user, pass })} size={148} level="M" />
                </div>
                <div className="flex flex-col gap-1.5 min-w-0">
                    <p className="font-medium text-small">
                        <Trans>Ready to scan</Trans>
                    </p>
                    <p className="text-xs leading-relaxed text-default-500 text-pretty">
                        <Trans>
                            The code holds the tunnel’s address, user and password. You can also
                            type them in by hand.
                        </Trans>
                    </p>
                </div>
            </div>
            {rows.map(([field, label, copyLabel, value]) => (
                <div key={field} className="flex items-center gap-3 py-1.5 pl-4 pr-2 min-h-11">
                    <span className="w-20 shrink-0 text-small text-default-500">{label}</span>
                    <span
                        className="flex-1 min-w-0 font-mono truncate select-all text-small"
                        title={value}
                    >
                        {value}
                    </span>
                    <CopyButton
                        label={copyLabel}
                        done={copied === field}
                        onPress={() => onCopy(field, value)}
                    />
                </div>
            ))}
        </Panel>
    )
}

function CopyButton({
    label,
    done,
    onPress,
}: {
    label: string
    done: boolean
    onPress: () => void
}) {
    return (
        <span className="flex items-center gap-1 shrink-0">
            <span aria-live="polite" className="text-xs font-medium text-success">
                {done ? t`Copied` : ''}
            </span>
            <button
                type="button"
                aria-label={label}
                onClick={onPress}
                className="grid transition-colors duration-150 ease-out rounded-lg outline-none place-items-center size-8 text-default-500 hover:bg-default-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
            >
                {done ? (
                    <CheckIcon className="size-4 text-success" />
                ) : (
                    <PageIcon className="size-4" />
                )}
            </button>
        </span>
    )
}

function QrPlaceholder() {
    return (
        <div className="flex items-center gap-4 p-4 border border-dashed rounded-2xl border-default-300 dark:border-default-200">
            <svg
                viewBox="0 0 40 40"
                aria-hidden={true}
                className="size-14 shrink-0 text-default-300 dark:text-default-200"
                fill="currentColor"
            >
                <path d="M2 2h12v12H2zm3 3v6h6V5zm21-3h12v12H26zm3 3v6h6V5zM2 26h12v12H2zm3 3v6h6v-6z" />
                <rect x="7" y="7" width="2" height="2" />
                <rect x="31" y="7" width="2" height="2" />
                <rect x="7" y="31" width="2" height="2" />
                <path d="M18 2h4v4h-4zm0 8h4v4h-4zm-4 8h4v4h-4zm8 0h4v4h-4zm8 0h8v4h-8zM2 18h8v4H2zm16 8h4v4h-4zm8 4h4v4h-4zm8-4h4v8h-4zm-8 8h4v4h-4zm-8 0h4v4h-4z" />
            </svg>
            <p className="text-small text-default-500 text-pretty">
                <Trans>The code appears here once the tunnel is on.</Trans>
            </p>
        </div>
    )
}

/** Running the same tunnel in a terminal, folded away because most people won't. */
function Terminal({
    command,
    copied,
    onCopy,
    pathHint,
}: {
    command: string
    copied: boolean
    onCopy: () => void
    pathHint: boolean
}) {
    const [open, setOpen] = useState(false)
    const id = useId()
    const reduceMotion = useReducedMotion()
    return (
        <Panel>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setOpen((o) => !o)}
                className="flex items-center w-full gap-3 px-4 py-3 text-left outline-none rounded-2xl focus-visible:ring-2 focus-visible:ring-primary"
            >
                <IconTile icon={TerminalSquareIcon} tone="graphite" />
                <span className="flex flex-col flex-1 min-w-0">
                    <span className="font-medium text-small">
                        <Trans>Run it in a terminal instead</Trans>
                    </span>
                    <span className="text-xs text-default-500">
                        <Trans>The same tunnel, without Rclone UI.</Trans>
                    </span>
                </span>
                <AngleDownSmallIcon
                    aria-hidden={true}
                    className={cn(
                        'size-4 text-default-500 transition-transform duration-200 ease-out motion-reduce:transition-none',
                        open && 'rotate-180'
                    )}
                />
            </button>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        id={id}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={
                            reduceMotion
                                ? { duration: 0 }
                                : { type: 'spring', bounce: 0, duration: 0.3 }
                        }
                        className="overflow-hidden"
                    >
                        <div className="flex flex-col gap-2.5 px-4 pb-4">
                            <div className="flex items-start gap-2 py-1.5 pl-3 pr-1.5 rounded-xl bg-default-100 dark:bg-black/30">
                                <code className="flex-1 min-w-0 py-1.5 font-mono text-small wrap-break-word">
                                    {command}
                                </code>
                                <CopyButton
                                    label={t`Copy the command`}
                                    done={copied}
                                    onPress={onCopy}
                                />
                            </div>
                            <p className="text-xs leading-relaxed text-default-500 text-pretty">
                                <Trans>
                                    It prints the QR code in the terminal and runs until you press
                                    Ctrl-C. It serves rclone's default config; add --config to pick
                                    another.
                                </Trans>
                                {pathHint && (
                                    <>
                                        {' '}
                                        <Trans>
                                            Turn on “Add rclone to PATH” in Settings to run it as{' '}
                                            <code>rclone tunnel</code>.
                                        </Trans>
                                    </>
                                )}
                            </p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </Panel>
    )
}

function Problem({
    title,
    action,
    children,
}: {
    title: string
    action?: ReactNode
    children: ReactNode
}) {
    return (
        <div
            role="alert"
            className="flex items-start gap-3 p-4 rounded-2xl bg-danger-50/70 ring-1 ring-inset ring-danger/20 dark:bg-danger/10"
        >
            <ExclamationTriangleIcon className="size-5 mt-px shrink-0 text-danger" />
            <div className="flex flex-col items-start flex-1 min-w-0 gap-1">
                <p className="font-medium text-small">{title}</p>
                <div className="text-small text-default-600 text-pretty">{children}</div>
                {action && <div className="pt-2">{action}</div>}
            </div>
        </div>
    )
}

function StoreButton({ store, onPress }: { store: 'apple' | 'google'; onPress: () => void }) {
    const apple = store === 'apple'
    return (
        <button
            type="button"
            onClick={onPress}
            className={cn(
                'flex items-center gap-2.5 h-12 pl-3 pr-4 rounded-xl text-left text-white bg-black outline-none',
                'shadow-[0_0_0_1px_rgb(0_0_0/0.9),0_2px_6px_-2px_rgb(0_0_0/0.4)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.18)]',
                'transition-[translate,scale,box-shadow] duration-150 ease-out hover:-translate-y-0.5 active:scale-[0.96]',
                'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
                'focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background'
            )}
        >
            {apple ? <AppleMark /> : <PlayMark />}
            <span className="flex flex-col">{apple ? <AppleBadge /> : <PlayBadge />}</span>
        </button>
    )
}

// The badges' words, as Apple and Google write them: a small line over the store's name.
const SMALL = 'text-[10px] leading-tight tracking-wide opacity-80'
const LARGE = 'text-base font-semibold leading-tight tracking-tight'

function AppleBadge() {
    return (
        <Trans comment="The App Store badge: a small line over the store's name.">
            <span className={SMALL}>Download on the</span>
            <span className={LARGE}>App Store</span>
        </Trans>
    )
}

function PlayBadge() {
    return (
        <Trans comment="The Google Play badge: a small line over the store's name.">
            <span className={SMALL}>Get it on</span>
            <span className={LARGE}>Google Play</span>
        </Trans>
    )
}

function AppleMark() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden={true} className="size-6 shrink-0" fill="currentColor">
            <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
        </svg>
    )
}

function PlayMark() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden={true} className="size-5 shrink-0">
            <path
                fill="#00D7FE"
                d="M1.337.924a1.486 1.486 0 0 0-.112.568v21.017c0 .217.045.419.124.6l11.155-11.087z"
            />
            <path
                fill="#FFCE00"
                d="M22.018 13.298l-3.919 2.218-3.515-3.493 3.543-3.521 3.891 2.202a1.49 1.49 0 0 1 0 2.594z"
            />
            <path
                fill="#00F076"
                d="M13.544 10.989l3.258-3.238L3.45.195a1.466 1.466 0 0 0-.946-.179z"
            />
            <path
                fill="#FF3A44"
                d="M13.544 13.056l-11 10.933c.298.036.612-.016.906-.183l13.324-7.54z"
            />
        </svg>
    )
}

/**
 * The picture of a phone beside the steps, with a glow of the window's tone behind it. It is left
 * out of a narrow window.
 */
function Phone() {
    return (
        <div
            aria-hidden={true}
            className="fixed bottom-0 hidden pointer-events-none select-none min-[720px]:block w-[288px]"
            style={{ right: 'calc((100vw - min(100vw - 48px, 768px)) / 2)' }}
        >
            <div
                className="absolute -inset-x-16 -top-12 -bottom-24 blur-3xl opacity-70 dark:opacity-60"
                style={{
                    background: `radial-gradient(closest-side, rgb(${TONE_RGB.indigo} / 0.35), transparent)`,
                }}
            />
            <img src="/mobile.png" alt="" draggable={false} className="relative w-full" />
        </div>
    )
}

/** The host of the tunnel's address, which is all of it that matters at a glance. */
function hostOf(url: string | undefined): string {
    if (!url) return ''
    try {
        return new URL(url).host
    } catch {
        return url
    }
}
