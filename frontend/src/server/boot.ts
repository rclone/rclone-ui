// What the server injects into index.html before any module runs (src/static_files.rs
// `boot_payload`), read synchronously at import time.

export interface Capabilities {
    platform: string
    containerized: boolean
    updater: boolean
    processExit: boolean
}

export interface BootPayload {
    version: string
    capabilities: Capabilities
    /** The machine the server (and so rclone) runs on. */
    os: { platform: string }
    paths: {
        sep: string
        home: string | null
        /** The server's own binary — what the metadata mapper runs (`paths.exe`). */
        exe: string | null
    }
}

declare global {
    interface Window {
        __RCLONE_CLOUD__?: BootPayload
    }
}

const FALLBACK: BootPayload = {
    version: '0.0.0',
    capabilities: {
        platform: 'linux',
        containerized: false,
        updater: false,
        processExit: false,
    },
    os: { platform: 'linux' },
    paths: { sep: '/', home: null, exe: null },
}

export const boot: BootPayload =
    typeof window !== 'undefined' && window.__RCLONE_CLOUD__ ? window.__RCLONE_CLOUD__ : FALLBACK

// What the host can do; pages hide UI the host cannot back (updates, quitting).
export const capabilities: Capabilities = boot.capabilities
// The server's machine: its path separator, its home folder, and its own binary, which rclone
// runs as the metadata mapper (`lib/rclone/metadataMapper.ts`).
export const sep = boot.paths.sep
export const home = boot.paths.home ?? ''
export const exe = boot.paths.exe ?? ''
