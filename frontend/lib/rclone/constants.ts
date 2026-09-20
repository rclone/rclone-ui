export const RCLONE_CONFIG_DEFAULTS = {
    copy: {
        'multi_thread_streams': 8,
    },
    config: {
        'transfers': 8,
        'checkers': 16,
    },
} as const

export const RCLONE_CONF_REGEX = /[\/\\]rclone\.conf$/
export const DOUBLE_BACKSLASH_REGEX = /\\\\/g

/** The rclone.org page for a subcommand (`copy`, `copyurl`, `mount`, …). */
export function rcloneDocsUrl(command: string): string {
    return `https://rclone.org/commands/rclone_${command}/`
}
/** How many releases the Rclone screen lists at first. */
export const RCLONE_RELEASES_SHOWN = 20
/** How many more the settings ask for each time Load more is pressed. */
export const RCLONE_RELEASES_STEP = 10

export const SERVE_TYPES = ['dlna', 'ftp', 'sftp', 'http', 'nfs', 'restic', 's3', 'webdav'] as const

// Backend capabilities are read per-remote from the rclone RC
// `operations/fsinfo` endpoint (see `fsInfoQueryOptions` / `hasFeature` in lib/hooks.ts), which is
// authoritative and correct for wrapping backends (crypt/alias/union) that static type lists could
// not express.
