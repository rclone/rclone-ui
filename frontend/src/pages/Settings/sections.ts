import type { LucideIcon } from 'lucide-react'
import {
    BellIcon,
    CloudCogIcon,
    CodeIcon,
    CogIcon,
    InfoIcon,
    MailIcon,
    PackageIcon,
    SatelliteDishIcon,
    ServerIcon,
    UsersIcon,
} from 'lucide-react'
import type { ComponentType } from 'react'
import AboutSection from './AboutSection'
import BinarySection from './BinarySection'
import ConfigSection from './ConfigSection'
import GeneralSection from './GeneralSection'
import NotificationsSection from './NotificationsSection'
import ProxySection from './ProxySection'
import RcloneSection from './RcloneSection'
import RemotesSection from './RemotesSection'
import SmtpSection from './SmtpSection'
import TeamSection from './TeamSection'

// The settings sections by their tab key (`/settings?tab=<key>` on the desktop,
// `/settings/<key>` in the browser shell), with the rules the tabbed window applies.
export type SectionKey =
    | 'general'
    | 'remotes'
    | 'notifications'
    | 'team'
    | 'config'
    | 'binary'
    | 'rclone'
    | 'smtp'
    | 'proxy'
    | 'about'

export interface SettingsSection {
    label: string
    icon: LucideIcon
    component: ComponentType
    /** Why the section is unavailable when the current host is not the local machine. */
    localOnly?: string
}

export const SETTINGS_SECTIONS: Record<SectionKey, SettingsSection> = {
    general: { label: 'General', icon: CogIcon, component: GeneralSection },
    remotes: { label: 'Remotes', icon: ServerIcon, component: RemotesSection },
    notifications: { label: 'Notifications', icon: BellIcon, component: NotificationsSection },
    // Browser only: accounts are the server's; the desktop's windows use a launch token.
    team: { label: 'Team', icon: UsersIcon, component: TeamSection },
    config: {
        label: 'Config',
        icon: CodeIcon,
        component: ConfigSection,
        localOnly:
            'Config settings are only available when using your local machine, not a remote host',
    },
    binary: {
        label: 'Binary',
        icon: PackageIcon,
        component: BinarySection,
        localOnly:
            'Rclone settings are only available when using your local machine, not a remote host',
    },
    proxy: { label: 'Proxy', icon: SatelliteDishIcon, component: ProxySection },
    // Browser only: the same settings as Binary and Proxy on one screen, in a layout for a wide
    // tab. The desktop's tabbed window keeps those two sections instead.
    rclone: { label: 'Rclone', icon: CloudCogIcon, component: RcloneSection },
    // The mail server the Email notification targets go through; both products.
    smtp: { label: 'SMTP', icon: MailIcon, component: SmtpSection },
    about: { label: 'About', icon: InfoIcon, component: AboutSection },
}

export function isSectionKey(value: string | undefined): value is SectionKey {
    return value !== undefined && Object.prototype.hasOwnProperty.call(SETTINGS_SECTIONS, value)
}
