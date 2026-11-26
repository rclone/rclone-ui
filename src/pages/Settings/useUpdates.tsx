import { Button } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
    ArrowsRotate as ArrowsRotateIcon,
    CheckCircle as CheckCircleIcon,
    DownloadBracket as DownloadBracketIcon,
    InfoCircle as InfoCircleIcon,
} from '@zappicon/react'
import { type ReactNode, startTransition, useEffect, useState } from 'react'
import { formatErrorMessage } from '../../../lib/errors'
import { saveSettings, useSettings } from '../../../lib/settings'
import { message, openUrl, updater } from '../../../lib/shell'
import { SwitchRow } from './SettingsGroup'

const UPDATE_FLOW_TEXT: Record<string, string> = {
    downloading: t`Downloading…`,
    installing: t`Installing…`,
}

type Found =
    | { kind: 'none' }
    | { kind: 'checking' }
    | { kind: 'current' }
    | { kind: 'failed' }
    | { kind: 'release'; version: string; page: string }

function checkLabel(found: Found, manual: boolean): string {
    switch (found.kind) {
        case 'release': {
            const version = found.version
            return manual
                ? t({
                      message: `Download ${version}`,
                      comment: 'Button: opens the page of a release, such as "Download 4.1.0".',
                  })
                : t({
                      message: `Update to ${version}`,
                      comment: 'Button: installs a release, such as "Update to 4.1.0".',
                  })
        }
        case 'checking':
            return t`Checking…`
        case 'current':
            return t`Up to date`
        case 'failed':
            return t`Check again`
        default:
            return t`Check for updates`
    }
}

export function useUpdates(): { button: ReactNode; footer: ReactNode } {
    const availableQuery = useQuery({
        queryKey: ['updater', 'available'],
        queryFn: () => updater.available(),
    })
    const { settings } = useSettings()
    const [found, setFound] = useState<Found>({ kind: 'none' })
    const [flowText, setFlowText] = useState<string | null>(null)

    useEffect(
        () =>
            updater.onState((state) => {
                startTransition(() => setFlowText(UPDATE_FLOW_TEXT[state.phase] ?? null))
            }),
        []
    )

    const checkMutation = useMutation({
        mutationFn: async () => {
            if (found.kind === 'release') {
                if (availableQuery.data?.manual) {
                    await openUrl(found.page)
                } else {
                    await updater.install()
                }
                return
            }
            setFound({ kind: 'checking' })
            const release = await updater.check()
            setFound(
                release
                    ? { kind: 'release', version: release.version, page: release.page }
                    : { kind: 'current' }
            )
        },
        onError: async (error) => {
            setFound({ kind: 'failed' })
            await message(formatErrorMessage(error, String(error)), {
                title: t`Updates`,
                kind: 'error',
            })
        },
    })

    const availability = availableQuery.data
    if (!availability) {
        return { button: null, footer: null }
    }

    const why = (
        <p className="flex items-start gap-2 px-6 py-3.5 text-xs leading-relaxed text-default-500">
            <InfoCircleIcon className="size-4 shrink-0" />
            {availability.why || t`This copy of Rclone UI can't update itself.`}
        </p>
    )
    if (!availability.ok && !availability.manual) {
        return { button: null, footer: why }
    }

    const label = flowText ?? checkLabel(found, !!availability.manual)
    const icon =
        found.kind === 'release' ? (
            <DownloadBracketIcon className="size-4" />
        ) : found.kind === 'current' ? (
            <CheckCircleIcon className="size-4" />
        ) : (
            <ArrowsRotateIcon className="size-4" />
        )

    return {
        button: (
            <Button
                color={found.kind === 'release' ? 'success' : 'primary'}
                variant={found.kind === 'current' ? 'flat' : 'solid'}
                isLoading={checkMutation.isPending}
                startContent={checkMutation.isPending ? undefined : icon}
                onPress={() => setTimeout(() => checkMutation.mutate(), 100)}
                data-focus-visible="false"
                className="font-medium shrink-0"
            >
                {label}
            </Button>
        ),
        footer: (
            <>
                <SwitchRow
                    title={t`Beta releases`}
                    description={t`Get new releases before they're marked stable.`}
                    isSelected={settings?.updates?.channel === 'beta'}
                    onValueChange={(beta) => {
                        setFound({ kind: 'none' })
                        saveSettings({ channel: beta ? 'beta' : 'stable' })
                    }}
                />
                {availability.manual && <div className="border-t border-divider">{why}</div>}
            </>
        ),
    }
}
