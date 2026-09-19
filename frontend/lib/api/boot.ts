// What the server injects into index.html before any module runs (src/static_files.rs
// `boot_payload`), read synchronously at import time by os.ts / paths.ts / host.ts.

export interface Capabilities {
    platform: string
    containerized: boolean
    updater: boolean
    processExit: boolean
}

export interface BootPayload {
    version: string
    capabilities: Capabilities
    os: {
        platform: string
        family: string
        arch: string
        version: string
        eol: string
    }
    paths: {
        sep: string
        delimiter: string
        home: string | null
        appData: string
        temp: string
        /** The server's own binary — what the metadata mapper runs (`paths.exe`). */
        exe: string | null
        download: string | null
        desktop: string | null
    }
    theme: 'light' | 'dark' | 'system'
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
    os: { platform: 'linux', family: 'unix', arch: 'x86_64', version: '', eol: '\n' },
    paths: {
        sep: '/',
        delimiter: ':',
        home: null,
        appData: '',
        temp: '/tmp',
        exe: null,
        download: null,
        desktop: null,
    },
    theme: 'system',
}

export const boot: BootPayload =
    typeof window !== 'undefined' && window.__RCLONE_CLOUD__ ? window.__RCLONE_CLOUD__ : FALLBACK
