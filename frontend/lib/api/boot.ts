// What the server injects into index.html before any module runs (src/static_files.rs
// `boot_payload`), read synchronously at import time by paths.ts / host.ts.

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
