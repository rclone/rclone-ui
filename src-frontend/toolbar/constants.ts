import type { ToolbarCommandId } from './types'

const COPY_DESCRIPTION =
    'Copy files from a source to a destination without deleting destination files.'
const MOVE_DESCRIPTION =
    'Move files from a source to a destination and delete them from the source.'
const SYNC_DESCRIPTION =
    'Sync source to destination, updating existing files and removing stale ones.'
const MOUNT_DESCRIPTION = 'Mount a remote to the local filesystem with VFS options.'
const DOWNLOAD_DESCRIPTION = 'Download a URL directly into a remote or local path.'
const SERVE_DESCRIPTION = 'Serve a remote over HTTP, WebDAV, SFTP, FTP and Restic.'
const BISYNC_DESCRIPTION = 'Bi-directional sync keeping source and destination in parity.'
const DELETE_DESCRIPTION = 'Delete files or folders from a remote or local path.'
const PURGE_DESCRIPTION = 'Purge an entire path from a remote, deleting everything.'
const CLEANUP_DESCRIPTION = 'Cleanup a remote by removing trashed and partial files.'
const BROWSE_DESCRIPTION = 'Browse files and folders in a remote.'
const SETTINGS_DESCRIPTION = 'Open the Settings screen.'
const GITHUB_DESCRIPTION = 'Open an issue or check out the GitHub repository.'
const TRANSFERS_DESCRIPTION = 'Open the Transfers screen.'
const SCHEDULES_DESCRIPTION = 'Open the Schedules screen.'
const TEMPLATES_DESCRIPTION = 'Open the Templates screen.'
const REMOTE_CREATE_DESCRIPTION = 'Create a new remote.'
const REMOTE_EDIT_DESCRIPTION = 'Edit a remote.'
const REMOTE_AUTO_MOUNT_DESCRIPTION = 'Configure auto mount options for a remote.'
const REMOTE_LIST_DESCRIPTION = 'Show all configured remotes.'
const QUIT_DESCRIPTION = 'Quit the application.'
const VFS_DESCRIPTION = 'Forget the local cache for one or all remotes.'
const COMMANDER_DESCRIPTION = 'Open the Commander screen.'

export const COMMAND_CONFIG = {
    copy: { route: '/copy', windowLabel: 'Copy' },
    move: { route: '/move', windowLabel: 'Move' },
    sync: { route: '/sync', windowLabel: 'Sync' },
    mount: { route: '/mount', windowLabel: 'Mount' },
    download: { route: '/download', windowLabel: 'Download' },
    serve: { route: '/serve', windowLabel: 'Serve' },
    bisync: { route: '/bisync', windowLabel: 'Bisync' },
    delete: { route: '/delete', windowLabel: 'Delete' },
    purge: { route: '/purge', windowLabel: 'Purge' },
    cleanup: {},
    browse: {},
    settings: { route: '/settings', windowLabel: 'Settings' },
    github: { route: '/github', windowLabel: 'GitHub' },
    transfers: { route: '/transfers', windowLabel: 'Transfers' },
    schedules: { route: '/schedules', windowLabel: 'Schedules' },
    templates: { route: '/templates', windowLabel: 'Templates' },
    remoteCreate: {},
    remoteEdit: {},
    remoteAutoMount: {},
    remoteList: {},
    quit: {},
    vfs: {},
    commander: { route: '/commander', windowLabel: 'Commander' },
} as const

export const COMMAND_DESCRIPTIONS: Record<ToolbarCommandId, string> = {
    copy: COPY_DESCRIPTION,
    move: MOVE_DESCRIPTION,
    sync: SYNC_DESCRIPTION,
    mount: MOUNT_DESCRIPTION,
    download: DOWNLOAD_DESCRIPTION,
    serve: SERVE_DESCRIPTION,
    bisync: BISYNC_DESCRIPTION,
    delete: DELETE_DESCRIPTION,
    purge: PURGE_DESCRIPTION,
    cleanup: CLEANUP_DESCRIPTION,
    browse: BROWSE_DESCRIPTION,
    settings: SETTINGS_DESCRIPTION,
    github: GITHUB_DESCRIPTION,
    transfers: TRANSFERS_DESCRIPTION,
    schedules: SCHEDULES_DESCRIPTION,
    templates: TEMPLATES_DESCRIPTION,
    remoteCreate: REMOTE_CREATE_DESCRIPTION,
    remoteEdit: REMOTE_EDIT_DESCRIPTION,
    remoteAutoMount: REMOTE_AUTO_MOUNT_DESCRIPTION,
    remoteList: REMOTE_LIST_DESCRIPTION,
    quit: QUIT_DESCRIPTION,
    vfs: VFS_DESCRIPTION,
    commander: COMMANDER_DESCRIPTION,
}

export const COMMAND_KEYWORDS: Record<ToolbarCommandId, string[]> = {
    copy: ['copy', 'cp'],
    move: ['move', 'mv'],
    sync: ['sync', 'synchronise', 'synchronize'],
    mount: ['mount'],
    download: ['download', 'url', 'copyurl', 'copyto'],
    serve: ['serve', 'http', 'webdav', 'sftp', 'ftp', 'restic'],
    bisync: ['bisync'],
    delete: ['delete', 'remove', 'rm'],
    purge: ['purge', 'empty'],
    cleanup: ['cleanup', 'clean'],
    browse: ['browse', 'explore', 'open', 'view', 'files'],
    settings: ['settings', 'config', 'preferences'],
    github: ['github', 'issue', 'bug', 'feature'],
    transfers: ['transfer', 'job', 'task', 'history'],
    schedules: ['schedule', 'cron', 'task'],
    templates: ['template', 'example'],
    remoteCreate: ['new', 'remote', 'create'],
    remoteEdit: ['edit', 'remote', 'update', 'change'],
    remoteAutoMount: ['mount', 'remote', 'update', 'change'],
    remoteList: ['remote', 'list', 'show'],
    quit: ['quit', 'exit', 'close'],
    vfs: ['vfs', 'cache', 'forget'],
    commander: ['commander', 'explorer', 'navigator', 'navigate'],
}
