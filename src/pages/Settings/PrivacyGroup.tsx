import { t } from '@lingui/core/macro'
import { saveSettings, useSettings } from '../../../lib/settings'
import { useTelemetryInfo } from '../../../lib/telemetry'
import { SettingRow, SettingsGroup, SwitchRow } from './SettingsGroup'
import { SECTIONS } from './sections'

/**
 * The switch for what the app sends about how it is used (core/telemetry). It starts on, except
 * on Linux.
 */
export default function PrivacyGroup() {
    const { settings } = useSettings()
    const info = useTelemetryInfo()
    const choice = settings?.telemetry
    // DO_NOT_TRACK in the environment turns sharing off whatever the switch says.
    const refused = !!info?.doNotTrack

    return (
        <SettingsGroup id="privacy" {...SECTIONS.privacy}>
            <SwitchRow
                title={t`Share usage data and crash reports`}
                description={
                    refused
                        ? t`Off, because DO_NOT_TRACK is set on this computer.`
                        : t`Anonymous, and used only to improve Rclone UI.`
                }
                isSelected={!!choice?.enabled && !refused}
                isDisabled={refused}
                onValueChange={(value) => saveSettings({ telemetryEnabled: value })}
            />
            <SettingRow
                stacked={true}
                title={t`What is shared`}
                description={t`Which features you use, such as a copy or a mount, and with which kinds of storage, such as S3 or Google Drive. How long transfers take and how much they move. The app’s version, your system and your language. Reports of crashes and errors.`}
            />
            <SettingRow
                stacked={true}
                title={t`What is never shared`}
                description={t`Your files and their names. Your folders and paths. Your remotes’ names, settings and passwords. Your location.`}
            />
            {choice?.enabled && choice.id && !refused && (
                <SettingRow
                    stacked={true}
                    title={t`Anonymous ID`}
                    description={t`A random ID that the data is sent under. Turning sharing off forgets it, and turning it on again makes a new one.`}
                >
                    <code className="px-3 py-2 font-mono text-xs select-text rounded-xl bg-default-100 dark:bg-black/30">
                        {choice.id}
                    </code>
                </SettingRow>
            )}
            {info && !info.built && (
                <SettingRow
                    title={t`This build sends nothing`}
                    description={t`It was built without a key for the data, so the switch has no effect here.`}
                />
            )}
        </SettingsGroup>
    )
}
