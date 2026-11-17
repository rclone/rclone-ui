import { Button, Input, Spinner, Tab, Tabs, Tooltip, cn } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { getVersion as getUiVersion } from '@tauri-apps/api/app'
import { message } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { platform } from '@tauri-apps/plugin-os'
import {
    BellIcon,
    CodeIcon,
    CogIcon,
    EyeIcon,
    GlobeIcon,
    InfoIcon,
    MedalIcon,
    PackageIcon,
    SatelliteDishIcon,
    ServerIcon,
    TabletSmartphoneIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LOCAL_HOST_ID } from '../../../lib/hosts'
import { useIsPreview } from '../../../lib/preview'
import rclone from '../../../lib/rclone/client'
import { useStore } from '../../../store/memory'
import { useCurrentHost, usePersistedStore } from '../../../store/persisted'
import AboutSection from './AboutSection'
import BinarySection from './BinarySection'
import ConfigSection from './ConfigSection'
import GeneralSection from './GeneralSection'
import HostsSection from './HostsSection'
import LicenseSection from './LicenseSection'
import MobileSection from './MobileSection'
import NotificationsSection from './NotificationsSection'
import ProxySection from './ProxySection'
import RemotesSection from './RemotesSection'

export default function Settings() {
    const [searchParams] = useSearchParams()
    const isPreview = useIsPreview()
    const settingsPass = usePersistedStore((state) => state.settingsPass)
    const currentHost = useCurrentHost()
    const isRestartingRclone = useStore((state) => state.isRestartingRclone)
    const isLocalHost = useMemo(() => currentHost?.id === LOCAL_HOST_ID, [currentHost?.id])

    const defaultSelectedTab = useMemo(() => searchParams.get('tab') || 'general', [searchParams])

    const [passwordCheckInput, setPasswordCheckInput] = useState('')
    const [passwordCheckPassed, setPasswordCheckPassed] = useState(false)
    const [passwordVisible, setPasswordVisible] = useState(false)

    const { data: uiVersion } = useQuery({
        queryKey: ['versions', 'ui'],
        queryFn: async () => {
            const uiVersion = await getUiVersion()
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

    useEffect(() => {
        console.log('[Settings] cliVersionQuery', 'CHANGED')
        console.log('[Settings] cliVersionQuery.data', cliVersionQuery.data)
        console.log('[Settings] cliVersionQuery.isLoading', cliVersionQuery.isLoading)
        console.log('[Settings] cliVersionQuery.isError', cliVersionQuery.isError)
        console.log('[Settings] cliVersionQuery.isFetching', cliVersionQuery.isFetching)
        console.log('[Settings] cliVersionQuery.error?.message', cliVersionQuery.error?.message)
    }, [cliVersionQuery])

    const cliVersion = useMemo(() => {
        return cliVersionQuery.data
    }, [cliVersionQuery.data])

    if (!defaultSelectedTab) return null

    if (isRestartingRclone) {
        return (
            <div className="flex flex-col items-center justify-center w-screen h-screen gap-10 overflow-hidden animate-fade-in">
                <Spinner size="lg" className="scale-150" />
                <p className="text-lg text-center text-neutral-500">Restarting rclone...</p>
            </div>
        )
    }

    const checkPassword = async () => {
        if (passwordCheckInput === settingsPass) {
            setPasswordCheckPassed(true)
            return
        }
        await message('The password you entered is incorrect.', {
            title: 'Login failed',
            kind: 'error',
        })
    }

    if (settingsPass && !passwordCheckPassed) {
        return (
            <div className="flex flex-col items-center justify-center w-screen h-screen gap-4 overflow-hidden animate-fade-in">
                <Input
                    placeholder="Enter pin or password"
                    value={passwordCheckInput}
                    onChange={(e) => setPasswordCheckInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') checkPassword()
                    }}
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                    type={passwordVisible ? 'text' : 'password'}
                    fullWidth={false}
                    size="lg"
                    endContent={
                        <Button
                            onPress={() => setPasswordVisible(!passwordVisible)}
                            isIconOnly={true}
                            variant="light"
                            data-focus-visible="false"
                        >
                            <EyeIcon className="w-5 h-5" />
                        </Button>
                    }
                />
                <Button onPress={checkPassword} data-focus-visible="false" color="primary">
                    Open
                </Button>
            </div>
        )
    }

    return (
        <div className={cn('relative flex flex-col w-screen h-screen gap-0 overflow-hidden')}>
            <Tabs
                aria-label="Options"
                isVertical={true}
                variant="light"
                destroyInactiveTabPanel={false}
                disableAnimation={true}
                className="flex-shrink-0 h-screen px-2 py-4 overflow-y-auto border-r w-52 dark:bg-transparent bg-content2 border-divider dark:border-neutral-700"
                classNames={{
                    // pb clears the fixed version bar (and the connected-host strip above it) so the
                    // last tabs stay reachable once the list scrolls. pt-6 clears macOS's
                    tabList:
                        'w-full gap-3 pb-10' +
                        (platform() === 'macos' && !isPreview ? ' pt-6' : ''),
                    tab: 'h-14 justify-start rounded-large',
                    tabContent: 'pl-8',
                }}
                size="lg"
                defaultSelectedKey={defaultSelectedTab}
                color="primary"
                radius="sm"
            >
                <Tab
                    key="general"
                    title={
                        <div className="flex items-center gap-2">
                            <CogIcon className="w-5 h-5" />
                            <span>General</span>
                        </div>
                    }
                    data-focus-visible="false"
                    className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                >
                    <GeneralSection />
                </Tab>
                <Tab
                    key="remotes"
                    title={
                        <div className="flex items-center gap-2">
                            <ServerIcon className="w-5 h-5" />
                            <span>Remotes</span>
                        </div>
                    }
                    data-focus-visible="false"
                    className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                >
                    <RemotesSection />
                </Tab>
                <Tab
                    key="notifications"
                    title={
                        <div className="flex items-center gap-2">
                            <BellIcon className="w-5 h-5" />
                            <span>Notifications</span>
                        </div>
                    }
                    data-focus-visible="false"
                    className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                >
                    <NotificationsSection />
                </Tab>
                <Tab
                    key="mobile"
                    title={
                        <Tooltip
                            content={
                                currentHost?.id !== 'local'
                                    ? 'Mobile access is only available when using your local machine, not a remote host'
                                    : undefined
                            }
                            isDisabled={currentHost?.id === 'local'}
                            placement="right"
                            size="lg"
                            color="foreground"
                            className="max-w-48"
                            offset={90}
                        >
                            <div className="flex items-center gap-2">
                                <TabletSmartphoneIcon className="w-5 h-5" />
                                <span>Mobile</span>
                            </div>
                        </Tooltip>
                    }
                    data-focus-visible="false"
                    className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                >
                    <MobileSection />
                </Tab>
                <Tab
                    key="hosts"
                    title={
                        <div className="flex items-center gap-2">
                            <GlobeIcon className="w-5 h-5" />
                            <span>Hosts</span>
                        </div>
                    }
                    data-focus-visible="false"
                    className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                >
                    <HostsSection />
                </Tab>
                <Tab
                    key="config"
                    title={
                        <Tooltip
                            content={
                                currentHost?.id !== 'local'
                                    ? 'Config settings are only available when using your local machine, not a remote host'
                                    : undefined
                            }
                            isDisabled={currentHost?.id === 'local'}
                            placement="right"
                            size="lg"
                            color="foreground"
                            className="max-w-48"
                            offset={90}
                        >
                            <div className="flex items-center gap-2">
                                <CodeIcon className="w-5 h-5" />
                                <span>Config</span>
                            </div>
                        </Tooltip>
                    }
                    data-focus-visible="false"
                    isDisabled={currentHost?.id !== 'local'}
                    className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                >
                    <ConfigSection />
                </Tab>
                <Tab
                    key="binary"
                    title={
                        <Tooltip
                            content={
                                currentHost?.id !== 'local'
                                    ? 'Rclone settings are only available when using your local machine, not a remote host'
                                    : undefined
                            }
                            isDisabled={currentHost?.id === 'local'}
                            placement="right"
                            size="lg"
                            color="foreground"
                            className="max-w-48"
                            offset={90}
                        >
                            <div className="flex items-center gap-2">
                                <PackageIcon className="w-5 h-5" />
                                <span>Binary</span>
                            </div>
                        </Tooltip>
                    }
                    data-focus-visible="false"
                    isDisabled={currentHost?.id !== 'local'}
                    className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                >
                    <BinarySection />
                </Tab>
                <Tab
                    key="proxy"
                    title={
                        // <Tooltip
                        //     content={
                        //         currentHost?.id !== 'local'
                        //             ? 'Proxy settings are only available when using your local machine, not a remote host'
                        //             : undefined
                        //     }
                        //     isDisabled={currentHost?.id === 'local'}
                        //     placement="right"
                        //     size="lg"
                        //     color="foreground"
                        //     className="max-w-48"
                        //     offset={97}
                        // >
                        <div className="flex items-center gap-2">
                            <SatelliteDishIcon className="w-5 h-5" />
                            <span>Proxy</span>
                        </div>
                        // </Tooltip>
                    }
                    data-focus-visible="false"
                    className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                >
                    <ProxySection />
                </Tab>
                {!isPreview && (
                    <Tab
                        key="license"
                        title={
                            <div className="flex items-center gap-2">
                                <MedalIcon className="w-5 h-5" />
                                <span>License</span>
                            </div>
                        }
                        data-focus-visible="false"
                        className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                    >
                        <LicenseSection />
                    </Tab>
                )}
                <Tab
                    key="about"
                    title={
                        <div className="flex items-center gap-2">
                            <InfoIcon className="w-5 h-5" />
                            <span>About</span>
                        </div>
                    }
                    data-focus-visible="false"
                    className="w-full max-h-screen p-0 overflow-scroll overscroll-none"
                >
                    <AboutSection />
                </Tab>
            </Tabs>
            {!isLocalHost && (
                <div className="absolute left-0 flex flex-col justify-center h-6 border-r w-52 bottom-12 bg-gradient-to-r from-primary-300 to-primary-400 border-divider dark:border-neutral-700">
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
    )
}
