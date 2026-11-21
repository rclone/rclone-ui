import { Button, cn, Input, Tab, Tabs } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import {
    Check as CheckIcon,
    Clipboard as ClipboardIcon,
    Eye as EyeIcon,
    EyeSlash as EyeSlashIcon,
} from '@zappicon/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { type ReactNode, startTransition, useEffect, useId, useState } from 'react'
import { formatErrorMessage, onErrorDialog, refusedFields } from '../../../lib/errors'
import { shellKeys } from '../../../lib/live'
import { saveSettings, updateSettings, useSettings } from '../../../lib/settings'
import { type AgentsInfo, agents, ask, clipboard, message } from '../../../lib/shell'
import { StatusDot, type StatusKind } from '../../components/look/Status'
import { toastSuccess } from '../../components/toast'
import { SEGMENTED, SettingRow, SettingsGroup, SwitchRow } from './SettingsGroup'
import { SECTIONS } from './sections'

/** The field that the core names when it refuses a port. */
const PORT_FIELD = 'agents.port'

/** What stands for the token on screen until it is shown. */
const MASK = '•'.repeat(12)

const RE_NOT_DIGIT = /\D/g

const CODE_BOX = 'rounded-xl bg-default-100 dark:bg-black/30'

/** The address of the server on a port. The server reports the same one once it runs. */
function urlAt(port: number): string {
    return `http://127.0.0.1:${port}/mcp`
}

/** The command that adds the server to Claude Code, for every project of the user's. */
function claudeCommand(url: string, token: string): string {
    return `claude mcp add --transport http --scope user rclone-ui ${url} --header "Authorization: Bearer ${token}"`
}

/**
 * The server in the settings of an app that starts a command. The path is written as a JSON
 * string, so a Windows path keeps its backslashes.
 */
function commandConfig(command: string): string {
    return [
        '{',
        '  "mcpServers": {',
        '    "rclone-ui": {',
        `      "command": ${JSON.stringify(command)},`,
        '      "args": ["mcp"]',
        '    }',
        '  }',
        '}',
    ].join('\n')
}

/**
 * The MCP server that lets the user's AI agents use the app (core/agents). It is off until the
 * switch turns it on.
 */
export default function AgentsGroup() {
    const { settings } = useSettings()
    const config = settings?.agents
    const on = !!config?.enabled
    // agents:changed keeps it current (followShellEvents).
    const status = useQuery({
        queryKey: shellKeys.agents,
        queryFn: () => agents.status(),
        enabled: on,
    }).data
    // The token is hidden in each new window. Showing it shows it in the setups too.
    const [revealed, setRevealed] = useState(false)
    const reduceMotion = useReducedMotion()

    return (
        <SettingsGroup id="agents" {...SECTIONS.agents}>
            <SwitchRow
                title={t`Let AI agents use Rclone UI`}
                description={t`An agent that you connect can browse your remotes, start and stop transfers, mounts and serves, and delete files, as you can in the windows. Only apps on this computer can connect, and your agent's app can ask you before each change.`}
                isSelected={on}
                isDisabled={!settings}
                onValueChange={(value) => saveSettings({ agentsEnabled: value })}
            />
            {/* The rows of the server open below the switch, so the groups under it slide down. */}
            <AnimatePresence initial={false}>
                {on && config && (
                    <motion.div
                        key="on"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={
                            reduceMotion
                                ? { duration: 0 }
                                : { type: 'spring', bounce: 0, duration: 0.35 }
                        }
                        className="overflow-hidden"
                    >
                        <div className="divide-y divide-divider">
                            <ServerRow port={config.port} status={status} />
                            <ConnectRow
                                url={status?.url || urlAt(config.port)}
                                command={status?.command ?? ''}
                                token={config.token}
                                revealed={revealed}
                            />
                            <TokenRow
                                token={config.token}
                                revealed={revealed}
                                onReveal={() => setRevealed((r) => !r)}
                            />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </SettingsGroup>
    )
}

function serverState(
    status: AgentsInfo | undefined,
    port: number
): { kind: StatusKind; title: string; detail: ReactNode } {
    if (status?.error) {
        return {
            kind: 'danger',
            title: t({
                message: "Couldn't start",
                comment:
                    'The server that lets AI agents connect could not start. The reason follows.',
            }),
            // The core's reason, in the app's language, says what to do.
            detail: status.error,
        }
    }
    // Until the status is read, and while the server starts, the row reads as starting, with the
    // address it is starting on, so it keeps its height when it runs.
    const url = status?.running ? status.url : urlAt(port)
    const at = (
        <Trans>
            At <span className="font-mono">{url}</span>, on this computer only.
        </Trans>
    )
    return status?.running
        ? { kind: 'success', title: t`Agents can connect`, detail: at }
        : { kind: 'active', title: t`Starting…`, detail: at }
}

function ServerRow({ port, status }: { port: number; status: AgentsInfo | undefined }) {
    const portId = useId()
    const [value, setValue] = useState(String(port))
    const [problem, setProblem] = useState('')
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        startTransition(() => setValue(String(port)))
    }, [port])

    const save = async () => {
        const newPort = Number(value)
        // The core refuses the same ports, and says so in the same words.
        if (!value || newPort < 1024 || newPort > 65535) {
            setProblem(t`The port is a number from 1024 to 65535.`)
            return
        }
        setIsSaving(true)
        try {
            await updateSettings({ agentPort: newPort })
            setProblem('')
            setValue(String(newPort))
            toastSuccess(
                t`Port changed to ${newPort}`,
                t`Apps that you set up with the old address need the new one.`
            )
        } catch (error) {
            setProblem(refusedFields(error)[PORT_FIELD] ?? formatErrorMessage(error))
        } finally {
            setIsSaving(false)
        }
    }

    const changed = value !== String(port)
    const state = serverState(status, port)

    return (
        <SettingRow
            title={
                <span role="status" className="flex items-center gap-2">
                    <StatusDot kind={state.kind} />
                    {state.title}
                </span>
            }
            description={
                <>
                    <span className="[overflow-wrap:anywhere]">{state.detail}</span>
                    {problem && (
                        <span role="alert" className="block mt-1 text-danger">
                            {problem}
                        </span>
                    )}
                </>
            }
        >
            <div className="flex items-center gap-2">
                <span id={portId} className="text-small text-default-500">
                    <Trans comment="The network port that the agents' server listens on.">
                        Port
                    </Trans>
                </span>
                <Input
                    aria-labelledby={portId}
                    size="sm"
                    inputMode="numeric"
                    maxLength={5}
                    value={value}
                    onValueChange={(v) => {
                        setValue(v.replace(RE_NOT_DIGIT, ''))
                        setProblem('')
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && changed && !isSaving) save()
                    }}
                    isInvalid={!!problem}
                    className="w-20"
                    classNames={{ input: 'font-mono text-small tabular-nums' }}
                    data-focus-visible="false"
                    autoComplete="off"
                    spellCheck="false"
                />
                <Button
                    size="sm"
                    color="primary"
                    onPress={save}
                    isDisabled={!changed || isSaving}
                    isLoading={isSaving}
                    data-focus-visible="false"
                >
                    <Trans>Save</Trans>
                </Button>
            </div>
        </SettingRow>
    )
}

/**
 * How to connect an agent's app, ready to copy. The command, the JSON, the address and the header
 * stay in English, because the apps read them.
 */
function ConnectRow({
    url,
    command,
    token,
    revealed,
}: {
    url: string
    command: string
    token: string
    revealed: boolean
}) {
    const titleId = useId()
    const shown = revealed ? token : MASK
    const header = (value: string) => `Authorization: Bearer ${value}`

    return (
        <SettingRow stacked={true} title={t`Connect your agent`} titleId={titleId}>
            <div className="flex flex-col">
                <Tabs
                    aria-labelledby={titleId}
                    size="sm"
                    radius="md"
                    classNames={{ ...SEGMENTED, panel: 'px-0 pt-3 pb-0' }}
                >
                    {/* A name, the same in every language. */}
                    <Tab key="claude-code" title="Claude Code">
                        <Setup
                            lead={t`Run this in a terminal. It adds Rclone UI to your agent, in all your projects.`}
                        >
                            <CodeBox
                                text={claudeCommand(url, token)}
                                shown={claudeCommand(url, shown)}
                                copyLabel={t`Copy the command`}
                            />
                        </Setup>
                    </Tab>
                    <Tab
                        key="command"
                        title={t({
                            message: 'Claude Desktop, Cursor',
                            comment:
                                'A tab: the setup for Claude Desktop, Cursor and the other apps that start a command. The names stay as they are.',
                        })}
                    >
                        <Setup
                            lead={t`For Claude Desktop, Cursor and other apps that start a command. Add this to the app's MCP configuration, then restart the app.`}
                            note={t`It needs no token. The app runs Rclone UI on this computer, as you. If Rclone UI isn't running, it starts by itself.`}
                        >
                            <CodeBox
                                text={commandConfig(command)}
                                copyLabel={t`Copy the configuration`}
                                block={true}
                            />
                        </Setup>
                    </Tab>
                    <Tab
                        key="http"
                        title={t({
                            message: 'Other (HTTP)',
                            comment:
                                'A tab: the setup for any other app, which connects to the server by its address, over HTTP.',
                        })}
                    >
                        <Setup
                            lead={t`For any other app that connects to an MCP server by its address. It sends the token in this header.`}
                        >
                            <div className={cn('flex flex-col divide-y divide-divider', CODE_BOX)}>
                                <CodeLine name={t`URL`} text={url} copyLabel={t`Copy the URL`} />
                                <CodeLine
                                    name={t({
                                        message: 'Header',
                                        comment: 'An HTTP header, which the app sends.',
                                    })}
                                    text={header(token)}
                                    shown={header(shown)}
                                    copyLabel={t`Copy the header`}
                                />
                            </div>
                        </Setup>
                    </Tab>
                </Tabs>
            </div>
        </SettingRow>
    )
}

function Setup({ lead, note, children }: { lead: string; note?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs leading-relaxed text-default-500 text-pretty">{lead}</p>
            {children}
            {note && <p className="text-xs leading-relaxed text-default-500 text-pretty">{note}</p>}
        </div>
    )
}

/**
 * Text to copy, in monospace, with its Copy button. A command wraps between its words, and a
 * `block`, such as JSON, keeps its lines and scrolls sideways. `shown` is what the screen shows,
 * with the token hidden.
 */
function CodeBox({
    text,
    shown = text,
    copyLabel,
    block,
}: {
    text: string
    shown?: string
    copyLabel: string
    block?: boolean
}) {
    return (
        <div className={cn('flex items-start gap-2 py-1 ps-3 pe-1', CODE_BOX)}>
            {block ? (
                <pre className="flex-1 min-w-0 py-1.5 overflow-x-auto font-mono text-[12.5px] leading-relaxed select-text">
                    <code>{shown}</code>
                </pre>
            ) : (
                <code className="flex-1 min-w-0 py-1.5 font-mono text-[12.5px] leading-relaxed select-text [overflow-wrap:anywhere]">
                    {shown}
                </code>
            )}
            <CopyButton text={text} label={copyLabel} />
        </div>
    )
}

function CodeLine({
    name,
    text,
    shown = text,
    copyLabel,
}: {
    name: string
    text: string
    shown?: string
    copyLabel: string
}) {
    return (
        <div className="flex items-start gap-3 py-1 ps-3 pe-1">
            <span className="w-20 py-1.5 shrink-0 text-xs leading-5 text-default-500">{name}</span>
            <code className="flex-1 min-w-0 py-1.5 font-mono text-[12.5px] leading-5 select-text [overflow-wrap:anywhere]">
                {shown}
            </code>
            <CopyButton text={text} label={copyLabel} />
        </div>
    )
}

function TokenRow({
    token,
    revealed,
    onReveal,
}: {
    token: string
    revealed: boolean
    onReveal: () => void
}) {
    const [isReplacing, setIsReplacing] = useState(false)

    const replace = async () => {
        const yes = await ask(
            t`Make a new token? Claude Code and the other apps that connect by the address stop working until you set them up again with the new one.`,
            {
                title: t`New token`,
                kind: 'warning',
                destructive: true,
                okLabel: t`Replace token`,
            }
        )
        if (!yes) return
        setIsReplacing(true)
        try {
            await updateSettings({ newAgentToken: true })
            toastSuccess(
                t`Token replaced`,
                t`Copy the new setup into the apps that connect by the address.`
            )
        } catch (error) {
            await onErrorDialog(t`Token not replaced`)(error)
        } finally {
            setIsReplacing(false)
        }
    }

    return (
        <SettingRow
            stacked={true}
            title={t`Token`}
            description={t`Claude Code and the other apps that connect by the address send it with each request. Keep it private.`}
        >
            <div className="flex flex-row flex-wrap items-center gap-2">
                <div
                    className={cn(
                        'flex items-center flex-1 gap-1 py-1 ps-3 pe-1 min-w-60',
                        CODE_BOX
                    )}
                >
                    <code
                        className={cn(
                            'flex-1 min-w-0 font-mono truncate text-[12.5px]',
                            revealed ? 'select-all' : 'select-none text-default-500'
                        )}
                    >
                        {revealed ? token : MASK}
                    </code>
                    <Button
                        isIconOnly={true}
                        size="sm"
                        variant="light"
                        aria-label={t`Show the token`}
                        aria-pressed={revealed}
                        onPress={onReveal}
                        className="text-default-500 data-[hover=true]:text-foreground"
                        data-focus-visible="false"
                    >
                        <SwapIcon id={revealed ? 'shown' : 'hidden'}>
                            {revealed ? (
                                <EyeSlashIcon className="size-4" />
                            ) : (
                                <EyeIcon className="size-4" />
                            )}
                        </SwapIcon>
                    </Button>
                    <CopyButton text={token} label={t`Copy the token`} />
                </div>
                <Button
                    color="danger"
                    variant="flat"
                    onPress={replace}
                    isDisabled={isReplacing}
                    isLoading={isReplacing}
                    data-focus-visible="false"
                >
                    <Trans>New token</Trans>
                </Button>
            </div>
        </SettingRow>
    )
}

function CopyButton({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false)
    useEffect(() => {
        if (!copied) return
        const timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
    }, [copied])
    return (
        <>
            <Button
                isIconOnly={true}
                size="sm"
                variant="light"
                aria-label={label}
                onPress={() =>
                    clipboard.setText(text).then(
                        () => setCopied(true),
                        (error: unknown) =>
                            message(formatErrorMessage(error), { title: label, kind: 'error' })
                    )
                }
                className="shrink-0 text-default-500 data-[hover=true]:text-foreground"
                data-focus-visible="false"
            >
                <SwapIcon id={copied ? 'copied' : 'copy'}>
                    {copied ? (
                        <CheckIcon className="size-4 text-success" />
                    ) : (
                        <ClipboardIcon className="size-4" />
                    )}
                </SwapIcon>
            </Button>
            <span className="sr-only" aria-live="polite">
                {copied
                    ? t({ message: 'Copied', comment: 'Button, after its text was copied.' })
                    : ''}
            </span>
        </>
    )
}

/** Animates from one icon to the next when `id` changes. */
function SwapIcon({ id, children }: { id: string; children: ReactNode }) {
    const reduceMotion = useReducedMotion()
    return (
        <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
                key={id}
                className="grid place-items-center"
                initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                transition={
                    reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.3, bounce: 0 }
                }
            >
                {children}
            </motion.span>
        </AnimatePresence>
    )
}
