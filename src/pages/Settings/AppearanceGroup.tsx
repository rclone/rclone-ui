import { Select, SelectItem, Tab, Tabs } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Desktop as DesktopIcon, Moon as MoonIcon, Sun as SunIcon } from '@zappicon/react'
import { useId } from 'react'
import { onErrorDialog } from '../../../lib/errors'
import { LANGUAGES, PSEUDO } from '../../../lib/i18n'
import { usePref } from '../../../lib/prefs'
import { saveSettings, TrayIcon, useSettings } from '../../../lib/settings'
import { isProduction, platform, systemLanguage } from '../../../lib/shell'
import { SEGMENTED, SettingRow, SettingsGroup, SwitchRow } from './SettingsGroup'
import { SECTIONS } from './sections'

type Theme = 'light' | 'dark' | 'system'

const THEMES: { key: Theme; label: string; icon: typeof SunIcon }[] = [
    { key: 'system', label: t`System`, icon: DesktopIcon },
    { key: 'light', label: t`Light`, icon: SunIcon },
    { key: 'dark', label: t`Dark`, icon: MoonIcon },
]

const TRAY_ICONS: [TrayIcon, string][] = [
    [TrayIcon.TrayIconSystem, t`System`],
    [TrayIcon.TrayIconLight, t`Light`],
    [TrayIcon.TrayIconDark, t`Dark`],
    [TrayIcon.TrayIconColor, t`Color`],
]

/** The key of the choice that follows the system's language (an empty language setting). */
const SYSTEM_LANGUAGE = 'system'

/**
 * The languages to choose from: the system's first, then each of the app's languages under its
 * own name, so that anyone finds theirs whatever language the app is in. A dev build adds the
 * test language.
 */
function languageChoices(): { key: string; label: string }[] {
    const system = LANGUAGES[systemLanguage()] ?? LANGUAGES.en
    return [
        { key: SYSTEM_LANGUAGE, label: t`System (${system})` },
        ...Object.entries(LANGUAGES).map(([key, label]) => ({ key, label })),
        ...(isProduction() ? [] : [{ key: PSEUDO, label: 'Pseudo (test)' }]),
    ]
}

export default function AppearanceGroup() {
    const { settings } = useSettings()
    const [theme, setTheme] = usePref('theme')
    const themeId = useId()
    const languageId = useId()
    const trayId = useId()

    const trayIcon =
        settings?.appearance.trayIcon && settings.appearance.trayIcon !== TrayIcon.TrayIconDefault
            ? settings.appearance.trayIcon
            : platform() === 'linux'
              ? TrayIcon.TrayIconColor
              : TrayIcon.TrayIconSystem

    return (
        <SettingsGroup id="appearance" {...SECTIONS.appearance}>
            <SettingRow
                title={t`Theme`}
                titleId={themeId}
                description={t`Follow your system, or always use light or dark.`}
            >
                <Tabs
                    aria-labelledby={themeId}
                    size="sm"
                    radius="md"
                    selectedKey={theme}
                    onSelectionChange={(key) => {
                        const value = String(key) as Theme
                        if (value && value !== theme) {
                            setTheme(value).catch(onErrorDialog(t`Theme not saved`))
                        }
                    }}
                    classNames={SEGMENTED}
                >
                    {THEMES.map(({ key, label, icon: Icon }) => (
                        <Tab
                            key={key}
                            title={
                                <span className="flex items-center gap-1.5">
                                    <Icon className="size-3.5" />
                                    {label}
                                </span>
                            }
                        />
                    ))}
                </Tabs>
            </SettingRow>

            <SettingRow
                title={t`Language`}
                titleId={languageId}
                description={t`The language for the app and notifications.`}
            >
                <Select
                    aria-labelledby={languageId}
                    size="sm"
                    className="w-52"
                    selectedKeys={[settings?.general.language || SYSTEM_LANGUAGE]}
                    disallowEmptySelection={true}
                    onSelectionChange={(keys) => {
                        const picked = [...keys][0]
                        if (picked === undefined) return
                        const next = picked === SYSTEM_LANGUAGE ? '' : String(picked)
                        if (next !== (settings?.general.language ?? '')) {
                            saveSettings({ language: next })
                        }
                    }}
                >
                    {languageChoices().map(({ key, label }) => (
                        <SelectItem key={key}>{label}</SelectItem>
                    ))}
                </Select>
            </SettingRow>

            {platform() === 'macos' && (
                <SwitchRow
                    title={t`Hide from Dock`}
                    description={t`Keep Rclone UI in the menu bar only. Turn this off to show its icon in the Dock and the app switcher.`}
                    isSelected={!settings?.general?.showInDock}
                    onValueChange={(value) => saveSettings({ showInDock: !value })}
                />
            )}

            {platform() !== 'macos' && (
                <SettingRow
                    title={t`Tray icon`}
                    titleId={trayId}
                    description={t`Follow your system, or always use a light, dark or color icon.`}
                >
                    <Tabs
                        aria-labelledby={trayId}
                        size="sm"
                        radius="md"
                        selectedKey={trayIcon}
                        onSelectionChange={(key) => {
                            const value = String(key ?? '') as TrayIcon
                            if (value && value !== trayIcon) saveSettings({ trayIcon: value })
                        }}
                        classNames={SEGMENTED}
                    >
                        {TRAY_ICONS.map(([icon, label]) => (
                            <Tab key={icon} title={label} />
                        ))}
                    </Tabs>
                </SettingRow>
            )}
        </SettingsGroup>
    )
}
