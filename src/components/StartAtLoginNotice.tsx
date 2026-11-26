import { Button, cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PowerOff as PowerIcon } from '@zappicon/react'
import { formatErrorMessage } from '../../lib/errors'
import { shellKeys } from '../../lib/live'
import { autostart, message } from '../../lib/shell'
import { IconTile } from './look/IconTile'
import { SURFACE } from './look/Panel'

const TEXT = {
    Watchers: t`Watchers run while Rclone UI is running, even with windows closed. Start it when you log in, so that they run after you restart your computer.`,
    Schedules: t`Schedules run while Rclone UI is running, even with no windows open. Start it when you log in, so that they run after you restart your computer.`,
    Automounts: t`Automounts mount when Rclone UI starts. Start it when you log in, so that they mount after you restart your computer.`,
}

export default function StartAtLoginNotice({ what }: { what: keyof typeof TEXT }) {
    const queryClient = useQueryClient()
    const enabled = useQuery({ queryKey: shellKeys.autostart, queryFn: () => autostart.get() })
    const enable = useMutation({
        mutationFn: () => autostart.set(true),
        onError: async (error) => {
            const reason = formatErrorMessage(error)
            await message(t`Rclone UI couldn't change whether it starts at login. ${reason}`, {
                title: t`Start at login`,
                kind: 'error',
            })
            await queryClient.invalidateQueries({ queryKey: shellKeys.autostart })
        },
    })
    if (enabled.data !== false) return null
    return (
        <div className="px-6 pb-4 shrink-0">
            <div
                className={cn(
                    SURFACE,
                    'flex flex-wrap items-center gap-x-3.5 gap-y-3 py-3 pl-3.5 pr-3'
                )}
            >
                <IconTile icon={PowerIcon} tone="green" size="md" />
                <p className="flex-1 leading-snug min-w-60 text-small text-default-600 text-pretty">
                    {TEXT[what]}
                </p>
                <Button
                    size="sm"
                    variant="flat"
                    color="primary"
                    isLoading={enable.isPending}
                    onPress={() => enable.mutate()}
                >
                    <Trans>Start at login</Trans>
                </Button>
            </div>
        </div>
    )
}
