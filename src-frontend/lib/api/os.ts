// Facts about the machine the server runs on (which, for the desktop, is this machine).
// Synchronous: they come from the boot script.

import { boot } from './boot'

export type Platform = 'macos' | 'windows' | 'linux' | string

export const platform: Platform = boot.os.platform
export const family = boot.os.family
export const arch = boot.os.arch
export const version = boot.os.version
export const eol = boot.os.eol

export const isMac = platform === 'macos'
/** A native macOS window: its overlay title bar needs top padding. Never true in a browser tab. */
export const isNativeMac = boot.capabilities.window && platform === 'macos'
export const isWindows = platform === 'windows'
export const isLinux = platform === 'linux'

/** `platform()`-compatible accessor for the few call sites that want a function. */
export function currentPlatform(): Platform {
    return platform
}
