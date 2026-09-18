import { Tab, Tabs, Tooltip, cn } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LOCAL_HOST_ID } from '../../../lib/hosts'

import { useIsPreview } from '../../../lib/preview'
import rclone from '../../../lib/rclone/client'
import { useCurrentHost } from '../../../store/persisted'
import SettingsGate from './SettingsGate'
import { type SectionKey, SETTINGS_SECTIONS } from './sections'
import { info as appInfo } from '../../../lib/api/app'
import { platform } from '../../../lib/api/os'
import { openUrl } from '../../../lib/api/shell'

// The tabbed window's order and its own rules: Team and Rclone are browser-only (absent here;
// Rclone is Binary and Proxy on one web-shaped screen),
// License is hidden in the preview build, and two sections are greyed out on a remote
// host rather than only explained (the catalog's `localOnly` text is the tooltip either way).
const DESKTOP_TABS: { key: SectionKey; disabledWhenRemote?: boolean; hiddenInPreview?: boolean }[] =
    [
        { key: 'general' },
        { key: 'remotes' },
        { key: 'notifications' },
        { key: 'smtp' },
        { key: 'hosts' },
        { key: 'config', disabledWhenRemote: true },
        { key: 'binary', disabledWhenRemote: true },
        { key: 'proxy' },
        { key: 'about' },
    ]

export default function Settings() {
    const [searchParams] = useSearchParams()
    const isPreview = useIsPreview()
    const currentHost = useCurrentHost()
    const isLocalHost = useMemo(() => currentHost?.id === LOCAL_HOST_ID, [currentHost?.id])

    const defaultSelectedTab = useMemo(() => searchParams.get('tab') || 'general', [searchParams])

    const { data: uiVersion } = useQuery({
        queryKey: ['versions', 'ui'],
        queryFn: async () => {
            const uiVersion = (await appInfo()).version
            return uiVersion.endsWith('.0') ? uiVersion.slice(0, -2) : uiVersion
        },
    })

    const cliVersionQuery = useQuery({
        queryKey: ['versions', 'cli'],
        queryFn: async () => {
            const cliVersion = await rclone('/core/version')
            return cliVersion.version.replace('v', '')
        },
    })

    const cliVersion = useMemo(() => {
        return cliVersionQuery.data
    }, [cliVersionQuery.data])

    if (!defaultSelectedTab) return null

    return (
        <SettingsGate>
            <div className={cn('relative flex flex-col w-screen h-screen gap-0 overflow-hidden')}>
                <Tabs
                    aria-label="Options"
                    isVertical={true}
                    variant="light"
                    destroyInactiveTabPanel={false}
                    disableAnimation={true}
                    className="flex-shrink-0 h-screen px-2 py-4 overflow-y-auto border-r w-52 dark:bg-transparent bg-content2 border-divider dark:border-neutral-700"
                    classNames={{
                        // The vertical wrapper must fill the page so the tab column's border runs the
                        // full height even when the section's content is short.
                        tabWrapper: 'h-full',
                        // pb clears the fixed version bar (and the connected-host strip above it) so the
                        // last tabs stay reachable once the list scrolls. pt-6 clears macOS's
                        tabList:
                            'w-full gap-3 pb-10' +
                            (platform === 'macos' && !isPreview ? ' pt-6' : ''),
                        tab: 'h-14 justify-start rounded-large',
                        tabContent: 'pl-8',
                    }}
                    size="lg"
                    defaultSelectedKey={defaultSelectedTab}
                    color="primary"
                    radius="sm"
                >
                    {DESKTOP_TABS.filter(
                        ({ hiddenInPreview }) => !(hiddenInPreview && isPreview)
                    ).map(({ key, disabledWhenRemote }) => {
                        const section = SETTINGS_SECTIONS[key]
                        const Icon = section.icon
                        const Section = section.component
                        const title = (
                            <div className="flex items-center gap-2">
                                <Icon className="w-5 h-5" />
                                <span>{section.label}</span>
                            </div>
                        )
                        return (
                            <Tab
                                key={key}
                                title={
                                    section.localOnly ? (
                                        <Tooltip
                                            content={!isLocalHost ? section.localOnly : undefined}
                                            isDisabled={isLocalHost}
                                            placement="right"
                                            size="lg"
                                            color="foreground"
                                            className="max-w-48"
                                            offset={90}
                                        >
                                            {title}
                                        </Tooltip>
                                    ) : (
                                        title
                                    )
                                }
                                data-focus-visible="false"
                                isDisabled={disabledWhenRemote && !isLocalHost}
                                className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                            >
                                <Section />
                            </Tab>
                        )
                    })}
                </Tabs>
                {!isLocalHost && (
                    <div
                        className={cn(
                            'absolute left-0 flex flex-col justify-center h-6 border-r w-52 bg-gradient-to-r from-primary-300 to-primary-400 border-divider dark:border-neutral-700 bottom-12'
                        )}
                    >
                        <p className="text-xs text-center text-foreground">
                            Connected to {currentHost?.name}
                        </p>
                    </div>
                )}
                <div className="absolute bottom-0 left-0 flex flex-col h-12 gap-4 p-4 border-t border-r w-52 bg-content3 dark:bg-content1 border-divider dark:border-neutral-700">
                    <p
                        className={cn(
                            'text-[10px] text-center  cursor-pointer',
                            isPreview
                                ? 'text-white font-semibold'
                                : 'text-neutral-500 hover:text-neutral-400 '
                        )}
                        onClick={() => openUrl('https://github.com/rclone-ui/rclone-ui')}
                    >
                        {isPreview ? 'rcloneui.com' : `UI v${uiVersion}, CLI v${cliVersion}`}
                    </p>
                </div>
            </div>
        </SettingsGate>
    )
}
