// What the server injects into index.html before any module runs (src-server/src/static_files.rs
// `boot_payload`), read synchronously at import time by os.ts / paths.ts / host.ts.

export interface Capabilities {
    platform: string
    containerized: boolean
    updater: boolean
    mount: boolean
    scheduler: boolean
    processExit: boolean
    configSync: boolean
    pathIntegration: boolean
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
        appLog: string | null
        logFile: string | null
        temp: string
        /** The server's own binary — what the metadata mapper runs (`paths.exe`). */
        exe: string | null
        download: string | null
        desktop: string | null
    }
    theme: 'light' | 'dark' | 'system'
    authRequired: boolean
}

export interface WindowPayload {
    label: string
}

declare global {
    interface Window {
        __RCLONE_UI__?: BootPayload
        __RCLONE_UI_WINDOW__?: WindowPayload
    }
}

const FALLBACK: BootPayload = {
    version: '0.0.0',
    capabilities: {
        platform: 'linux',
        containerized: false,
        updater: false,
        mount: true,
        scheduler: true,
        processExit: false,
        configSync: false,
        pathIntegration: false,
    },
    os: { platform: 'linux', family: 'unix', arch: 'x86_64', version: '', eol: '\n' },
    paths: {
        sep: '/',
        delimiter: ':',
        home: null,
        appData: '',
        appLog: null,
        logFile: null,
        temp: '/tmp',
        exe: null,
        download: null,
        desktop: null,
    },
    theme: 'system',
    authRequired: true,
}

export const boot: BootPayload =
    typeof window !== 'undefined' && window.__RCLONE_UI__ ? window.__RCLONE_UI__ : FALLBACK

/** The desktop window this page runs in (`undefined` in a browser tab). */
export const windowInfo: WindowPayload | undefined =
    typeof window !== 'undefined' ? window.__RCLONE_UI_WINDOW__ : undefined
