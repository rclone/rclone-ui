import { cn } from '@heroui/react'
import { useEffect } from 'react'
import { platform } from '../../../lib/shell'
import { usePageQuery } from '../../route'
import AboutHeader from './AboutHeader'
import AgentsGroup from './AgentsGroup'
import AppearanceGroup from './AppearanceGroup'
import HelpGroup from './HelpGroup'
import LauncherGroup from './LauncherGroup'
import Licenses from './Licenses'
import PrivacyGroup from './PrivacyGroup'
import RcloneGroup, { NetworkGroup } from './RcloneGroup'
import StartupGroup from './StartupGroup'
import { SECTION_IDS } from './sections'

/**
 * The Settings window. `?section=network` opens the window at that group (the proxy's restart
 * comes back to it).
 */
export default function Settings() {
    const asked = usePageQuery().get('section')
    useEffect(() => {
        if (asked && (SECTION_IDS as readonly string[]).includes(asked)) {
            document.getElementById(asked)?.scrollIntoView({ block: 'start' })
        }
    }, [asked])

    return (
        <div className={cn('flex flex-col w-screen h-screen', platform() === 'macos' && 'pt-7')}>
            <div className="relative flex-1 min-h-0 overflow-y-auto overscroll-none">
                <div className="flex flex-col w-full max-w-2xl px-8 pt-6 pb-16 mx-auto gap-9 max-[720px]:px-5">
                    <AboutHeader />
                    <AppearanceGroup />
                    <StartupGroup />
                    <LauncherGroup />
                    <NetworkGroup />
                    <RcloneGroup />
                    <AgentsGroup />
                    <PrivacyGroup />
                    <HelpGroup />
                    <Licenses />
                </div>
            </div>
        </div>
    )
}
