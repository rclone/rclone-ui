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

/** The text of the update button during the slow phases of the update flow. */
const UPDATE_FLOW_TEXT: Record<string, string> = {
    downloading: t`Downloading…`,
    installing: t`Installing…`,
}

/** What the last check found, which picks the button's text and icon. */
type Found =
    | { kind: 'none' }
    | { kind: 'checking' }
    | { kind: 'current' }
    | { kind: 'failed' }
    | { kind: 'release'; version: string; page: string }

/**
 * The update button's text for what the last check found. A release is offered as a download
 * from its page when the copy can't update itself (`manual`), and as an install otherwise.
 */
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

/**
 * The updates of the About header: `button` checks for updates, and `footer` holds Beta
 * releases. The shell's update flow does the rest: the download, the check for running work, and
 * the restart. An install that can't update itself (a Flatpak, or a copy that no installer put
 * there) has no button, and its footer says why. A portable copy can't update itself either, but
 * it still checks: its button then opens the release's page, and its footer says how to update
 * by hand.
 */
export function useUpdates(): { button: ReactNode; footer: ReactNode } {
    const availableQuery = useQuery({
        queryKey: ['updater', 'available'],
        queryFn: () => updater.available(),
    })
    const { settings } = useSettings()
    const [found, setFound] = useState<Found>({ kind: 'none' })
    // While the shell's update flow downloads or installs, the button shows what it is doing. It
    // goes back to its own text once the flow is idle again (the user declined the restart) or
    // has failed.
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
            {/* The core gives its reason in the app's language. */}
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
                        // A release found on the other channel is no longer the right one to offer.
                        setFound({ kind: 'none' })
                        saveSettings({ channel: beta ? 'beta' : 'stable' })
                    }}
                />
                {availability.manual && <div className="border-t border-divider">{why}</div>}
            </>
        ),
    }
}
