import { t } from '@lingui/core/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { reportError } from '../../../lib/errors'
import { shellKeys } from '../../../lib/live'
import { pathLink } from '../../../lib/shell'
import BandwidthRow from './BandwidthRow'
import ProxyRows from './ProxyRows'
import { SettingsGroup, SwitchRow } from './SettingsGroup'
import { SECTIONS } from './sections'

export default function RcloneGroup() {
    return (
        <SettingsGroup id="rclone" {...SECTIONS.rclone}>
            <PathLinkRow />
        </SettingsGroup>
    )
}

export function NetworkGroup() {
    return (
        <SettingsGroup id="network" {...SECTIONS.network}>
            <BandwidthRow />
            <ProxyRows />
        </SettingsGroup>
    )
}

/**
 * "Add rclone to PATH" adds a command named rclone that runs the app's rclone. It never replaces
 * an rclone that the user installed.
 */
function PathLinkRow() {
    const queryClient = useQueryClient()
    // pathlink:changed sets it when any window changes it, this one too (followShellEvents).
    const statusQuery = useQuery({ queryKey: shellKeys.pathLink, queryFn: () => pathLink.status() })

    const toggleMutation = useMutation({
        mutationFn: (enable: boolean) => (enable ? pathLink.enable() : pathLink.disable()),
        onError: async (e) => {
            await reportError(e, { title: t`PATH integration`, fallback: String(e) })
            await queryClient.invalidateQueries({ queryKey: shellKeys.pathLink })
        },
    })

    const status = statusQuery.data

    return (
        <SwitchRow
            title={t`Add rclone to PATH`}
            description={
                <>
                    {/* The core's reason and warning come in the app's language. */}
                    {status && !status.supported
                        ? status.reason
                        : t`Run the rclone command from any terminal.`}
                    {status?.warning && (
                        <span className="block mt-1 text-warning">{status.warning}</span>
                    )}
                </>
            }
            isSelected={status?.enabled ?? false}
            isDisabled={toggleMutation.isPending || !status?.supported}
            onValueChange={(checked) => toggleMutation.mutate(checked)}
        />
    )
}
