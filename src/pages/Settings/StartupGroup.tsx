import { t } from '@lingui/core/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatErrorMessage } from '../../../lib/errors'
import { shellKeys } from '../../../lib/live'
import { saveSettings, useSettings } from '../../../lib/settings'
import { autostart, message, platform } from '../../../lib/shell'
import { SettingsGroup, SwitchRow } from './SettingsGroup'
import { SECTIONS } from './sections'

export default function StartupGroup() {
    const { settings } = useSettings()

    return (
        <SettingsGroup id="startup" {...SECTIONS.startup}>
            <StartOnBootRow />

            <SwitchRow
                title={t`Show the startup screen`}
                description={t`A welcome window with the launcher's shortcut, each time Rclone UI starts.`}
                isSelected={!settings?.general?.hideStartup}
                onValueChange={(value) => saveSettings({ hideStartup: !value })}
            />

            {platform() !== 'linux' && (
                <SwitchRow
                    title={t`Resume after logout or restart`}
                    description={t`Mounts, serves and transfers that are running when you log out, restart or shut down start again the next time Rclone UI opens.`}
                    isSelected={!!settings?.general?.resumeAfterLogout}
                    onValueChange={(value) => saveSettings({ resumeAfterLogout: value })}
                />
            )}
        </SettingsGroup>
    )
}

function StartOnBootRow() {
    const queryClient = useQueryClient()
    // autostart:changed sets it when any window changes it, this one too (followShellEvents).
    const enabledQuery = useQuery({ queryKey: shellKeys.autostart, queryFn: () => autostart.get() })

    return (
        <SwitchRow
            title={t`Start at login`}
            description={t`Open Rclone UI when you log in to this computer.`}
            isSelected={!!enabledQuery.data}
            onValueChange={async (value) => {
                try {
                    await autostart.set(value)
                } catch (error) {
                    const reason = formatErrorMessage(error)
                    await message(
                        t`Rclone UI couldn't change whether it starts at login. ${reason}`,
                        {
                            title: t`Start at login`,
                            kind: 'error',
                        }
                    )
                    // A change that failed sends no event, so the switch reads the OS again.
                    await queryClient.invalidateQueries({ queryKey: shellKeys.autostart })
                }
            }}
        />
    )
}
