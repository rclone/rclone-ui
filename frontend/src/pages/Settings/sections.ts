import type { LucideIcon } from 'lucide-react'
import { BellIcon, CloudCogIcon, MailIcon, ServerIcon, UsersIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import NotificationsSection from './NotificationsSection'
import RcloneSection from './RcloneSection'
import RemotesSection from './RemotesSection'
import SmtpSection from './SmtpSection'
import TeamSection from './TeamSection'

// The settings sections by their key (`/settings/<key>`; Remotes is `/remotes`).
export type SectionKey = 'remotes' | 'notifications' | 'team' | 'rclone' | 'smtp'

export interface SettingsSection {
    label: string
    icon: LucideIcon
    component: ComponentType
}

export const SETTINGS_SECTIONS: Record<SectionKey, SettingsSection> = {
    remotes: { label: 'Remotes', icon: ServerIcon, component: RemotesSection },
    notifications: { label: 'Notifications', icon: BellIcon, component: NotificationsSection },
    team: { label: 'Team', icon: UsersIcon, component: TeamSection },
    // Which rclone binary the server runs, its limits and proxy, and the server's own updates.
    // All of it is this file's component; there is no separate route for any of them.
    rclone: { label: 'Rclone', icon: CloudCogIcon, component: RcloneSection },
    // The mail server the Email notification targets go through.
    smtp: { label: 'SMTP', icon: MailIcon, component: SmtpSection },
}

export function isSectionKey(value: string | undefined): value is SectionKey {
    return value !== undefined && Object.prototype.hasOwnProperty.call(SETTINGS_SECTIONS, value)
}
