/**
 * The pages of the app that the site lists its texts under, in the order it shows them. A text
 * belongs to the page of the file that uses it.
 */
export const APP_PAGES = [
    'Startup screen',
    'Launcher',
    'Commander',
    'Remotes',
    'Copy, Move, Sync and the other operations',
    'Bisync',
    'Delete',
    'Purge',
    'Download',
    'Mount',
    'Serve',
    'History',
    'Templates',
    'Schedules',
    'Watchers',
    'Automounts',
    'Run (wizard)',
    'Guides',
    'Settings',
    'Notifications',
    'Mobile & Remote Control',
    'Window titles',
    'Tray and menus',
    'Updates',
    'Shared parts',
    'Other native texts',
    'Errors and other messages',
] as const

const OPERATIONS = 'Copy, Move, Sync and the other operations'

/** The folders and files in src/pages, by their name. */
const BY_PAGE: Record<string, string> = {
    Startup: 'Startup screen',
    Launcher: 'Launcher',
    Commander: 'Commander',
    Remotes: 'Remotes',
    Copy: OPERATIONS,
    Move: OPERATIONS,
    Sync: OPERATIONS,
    Bisync: 'Bisync',
    Delete: 'Delete',
    Purge: 'Purge',
    Download: 'Download',
    downloadSites: 'Download',
    downloadFilename: 'Download',
    Mount: 'Mount',
    Serve: 'Serve',
    History: 'History',
    Templates: 'Templates',
    Schedules: 'Schedules',
    Watchers: 'Watchers',
    Automounts: 'Automounts',
    Wizard: 'Run (wizard)',
    Guides: 'Guides',
    Settings: 'Settings',
    Notifications: 'Notifications',
    MobileRemoteControl: 'Mobile & Remote Control',
}

/** Other folders and files, by the start of their path. The first match wins. */
const BY_PREFIX: [string, string][] = [
    ['src/components/navigator', 'Commander'],
    ['src/components/operation', OPERATIONS],
    ['src/components/MetadataMapper', OPERATIONS],
    ['src/components/PathFinder', OPERATIONS],
    ['src/components/PathSelector', OPERATIONS],
    ['src/components/OptionGroupEditor', OPERATIONS],
    ['src/components/RemoteOptionsEditor', OPERATIONS],
    ['src/components/CommandsDropdown', OPERATIONS],
    ['src/components/schedule', 'Schedules'],
    ['src/route', 'Window titles'],
    ['lib/notifications', 'Notifications'],
    ['lib/mounts', 'Mount'],
    ['lib/reconnect', 'Remotes'],
    ['lib/configs', 'Remotes'],
    ['lib/transfers', 'History'],
    ['src/', 'Shared parts'],
    ['lib/', 'Shared parts'],
    ['app/launcher', 'Launcher'],
    ['app/windows', 'Window titles'],
    ['app/tray', 'Tray and menus'],
    ['app/menus', 'Tray and menus'],
    ['app/update', 'Updates'],
    ['app/', 'Other native texts'],
    ['core/notifications', 'Notifications'],
    ['core/transfers', 'History'],
    ['core/operations', OPERATIONS],
    ['core/mounts', 'Mount'],
    ['core/serves', 'Serve'],
    ['core/schedules', 'Schedules'],
    ['core/templates', 'Templates'],
    ['core/watchers', 'Watchers'],
    ['core/remotes', 'Remotes'],
    ['core/config', 'Remotes'],
    ['core/filen', 'Remotes'],
    ['core/browse', 'Commander'],
    ['core/files', 'Commander'],
    ['core/media', 'Commander'],
    ['core/tunnel', 'Mobile & Remote Control'],
    ['core/settings', 'Settings'],
]

export function pageOfFile(path: string): string {
    if (path.startsWith('src/pages/')) {
        const part = path.split('/')[2]
        const page = BY_PAGE[part] ?? BY_PAGE[part.split('.')[0]]
        if (page) return page
    }
    return BY_PREFIX.find(([prefix]) => path.startsWith(prefix))?.[1] ?? 'Errors and other messages'
}

export function pageRank(title: string) {
    const i = APP_PAGES.indexOf(title as (typeof APP_PAGES)[number])
    return i === -1 ? APP_PAGES.length : i
}

export function slug(text: string) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
}
