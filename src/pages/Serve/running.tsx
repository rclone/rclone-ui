import { Button, Chip, cn, Tooltip } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Clipboard as ClipboardIcon } from '@zappicon/react'
import { useId, useState } from 'react'
import type { Serves } from '../../../lib/core/types'
import { formatErrorMessage } from '../../../lib/errors'
import { clipboard, message } from '../../../lib/shell'
import { IconTile } from '../../components/look/IconTile'
import { SURFACE } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { StatusDot, type StatusKind } from '../../components/look/Status'
import { toastSuccess } from '../../components/toast'
import { WINDOWS } from '../../routes'
import { protocolIcon, protocolName } from './protocols'
import { serveLabel, stopServe, useServes } from './serves'

// The Serve page's list of the running serves, each with a button to copy its address and a Stop
// button.

type State = { label: string; kind: StatusKind }

const STARTING: State = { label: t`Starting`, kind: 'active' }

const STATE: Record<string, State> = {
    starting: STARTING,
    running: {
        label: t({ message: 'Serving', comment: 'State of a serve: it is running.' }),
        kind: 'success',
    },
    restarting: { label: t`Restarting`, kind: 'warning' },
}

/** Returns how a serve's state is shown. An unknown state is shown as starting. */
function stateOf(state: string): State {
    return STATE[state] ?? STARTING
}

export async function copyServeAddress(serve: Serves.ServeRow) {
    try {
        await clipboard.setText(serve.addr)
    } catch (error) {
        await message(formatErrorMessage(error), { title: t`Copy address`, kind: 'error' })
        return
    }
    const address = serve.addr
    toastSuccess(t`Address Copied`, t`${address} copied to clipboard`)
}

function RestartChip() {
    return (
        <Tooltip
            content={t`A remote it serves changed. Stop it and serve again for the change to apply.`}
            placement="top"
            className="max-w-xs"
        >
            <Chip size="sm" variant="flat" color="warning" className="shrink-0">
                <Trans>Restart to apply</Trans>
            </Chip>
        </Tooltip>
    )
}

export function ServeList() {
    const serves = useServes()
    const [stopping, setStopping] = useState<string | null>(null)
    const titleId = useId()
    if (serves.length === 0) return null
    const stop = async (serve: Serves.ServeRow) => {
        setStopping(serve.id)
        try {
            await stopServe(serve.id)
            const address = serve.addr
            toastSuccess(t`Stopped serving on ${address}`)
        } catch (error) {
            await message(formatErrorMessage(error), { title: t`Stop Serve`, kind: 'error' })
        } finally {
            setStopping(null)
        }
    }
    return (
        <section aria-label={t`Serves`} className="flex flex-col gap-3">
            <SectionTitle
                id={titleId}
                className="px-1"
                title={
                    <span className="flex items-center gap-2">
                        <Trans>Serving now</Trans>
                        <Chip
                            size="sm"
                            variant="flat"
                            classNames={{
                                base: 'h-5 px-0.5',
                                content: 'px-1 font-semibold tabular-nums text-tiny',
                            }}
                        >
                            {serves.length}
                        </Chip>
                    </span>
                }
            />
            <ul
                aria-labelledby={titleId}
                className={cn(SURFACE, 'flex flex-col divide-y divide-divider')}
            >
                {serves.map((serve) => {
                    const state = stateOf(serve.state)
                    return (
                        <li
                            key={serve.id}
                            aria-label={serveLabel(serve)}
                            className="flex items-center gap-3.5 px-4 py-3"
                        >
                            <IconTile
                                icon={protocolIcon(serve.type)}
                                tone={WINDOWS.serve.tone}
                                size="lg"
                            />
                            <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                                <div className="flex items-center min-w-0 gap-2">
                                    <span className="font-medium truncate">{serve.source}</span>
                                    {serve.restart ? <RestartChip /> : null}
                                </div>
                                <div className="flex items-center min-w-0 gap-1.5 text-small text-default-500">
                                    <StatusDot kind={state.kind} />
                                    <span className="shrink-0">{state.label}</span>
                                    <span aria-hidden={true} className="text-default-300">
                                        ·
                                    </span>
                                    <span className="font-medium shrink-0 text-default-600">
                                        {protocolName(serve.type)}
                                    </span>
                                    <span className="font-mono truncate text-tiny">
                                        {serve.addr}
                                    </span>
                                </div>
                                {serve.error ? (
                                    <span className="text-tiny text-danger line-clamp-2">
                                        {serve.error}
                                    </span>
                                ) : null}
                            </div>
                            <Button
                                size="sm"
                                variant="flat"
                                startContent={<ClipboardIcon className="size-4" />}
                                onPress={() => copyServeAddress(serve)}
                                data-focus-visible="false"
                            >
                                <Trans>Copy address</Trans>
                            </Button>
                            <Button
                                size="sm"
                                variant="flat"
                                color="danger"
                                isLoading={stopping === serve.id}
                                isDisabled={stopping !== null && stopping !== serve.id}
                                onPress={() => stop(serve)}
                                data-focus-visible="false"
                            >
                                <Trans comment="Button: stops a running serve.">Stop</Trans>
                            </Button>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
