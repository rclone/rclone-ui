// Chooses where a new mount goes. It is a folder named after its remote in ~/Rclone (the core
// creates it if it is missing). On Windows it is the next free drive letter, which rclone picks
// when the mount point is "*".

const TRAILING_SLASHES = /\/+$/
const DRIVE_LETTER = /^[a-zA-Z]:$/

/** The mount point that tells rclone on Windows to use the next free drive letter. */
export const NEXT_FREE_DRIVE = '*'

/**
 * Reports whether a mount point is a drive rather than a folder. On Windows, that is a drive
 * letter (`M:`) or the next free one. A drive shouldn't be checked as a path, because as a path
 * `M:` means the current folder on that drive.
 */
export function isDrive(mountPoint: string, windows: boolean): boolean {
    return windows && (mountPoint === NEXT_FREE_DRIVE || DRIVE_LETTER.test(mountPoint))
}

/** Returns a suggested mount point for a remote, or none on Windows or when home is unknown. */
export function suggestedMountPoint(
    remote: string,
    home: string,
    windows: boolean
): string | undefined {
    if (windows || !home) return undefined
    return `${home.replace(TRAILING_SLASHES, '')}/Rclone/${remote}`
}

/**
 * Returns the mount point to start with: the one typed or picked, or else the suggestion. On
 * Windows, an empty one means the next free drive letter. `typed` is undefined until the user
 * edits the field.
 */
export function mountPointOf(
    typed: string | undefined,
    suggestion: string | undefined,
    windows: boolean
): string | undefined {
    if (windows && !typed) return NEXT_FREE_DRIVE
    return typed ?? suggestion
}

/** Shortens a path under the home folder to "~/…" for display. Other paths are unchanged. */
export function tildePath(path: string, home: string): string {
    const base = home.replace(TRAILING_SLASHES, '')
    if (!base || base.includes('\\')) return path
    if (path === base) return '~'
    return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path
}
