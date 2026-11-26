const TRAILING_SLASHES = /\/+$/
const DRIVE_LETTER = /^[a-zA-Z]:$/

export const NEXT_FREE_DRIVE = '*'

/**
 * A drive shouldn't be checked as a path, because as a path `M:` means the current folder on
 * that drive.
 */
export function isDrive(mountPoint: string, windows: boolean): boolean {
    return windows && (mountPoint === NEXT_FREE_DRIVE || DRIVE_LETTER.test(mountPoint))
}

export function suggestedMountPoint(
    remote: string,
    home: string,
    windows: boolean
): string | undefined {
    if (windows || !home) return undefined
    return `${home.replace(TRAILING_SLASHES, '')}/Rclone/${remote}`
}

export function mountPointOf(
    typed: string | undefined,
    suggestion: string | undefined,
    windows: boolean
): string | undefined {
    if (windows && !typed) return NEXT_FREE_DRIVE
    return typed ?? suggestion
}

export function tildePath(path: string, home: string): string {
    const base = home.replace(TRAILING_SLASHES, '')
    if (!base || base.includes('\\')) return path
    if (path === base) return '~'
    return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path
}
