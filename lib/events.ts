import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ConfigFile } from '../types/config'

// Wire names for the cross-window app-lifecycle events. These strings cross the Tauri event bus
// and are listened for in main.ts (loaded only by the hidden 'main' window) — keep them stable.
export const CLOSE_APP = 'close-app'
export const RELAUNCH_APP = 'relaunch-app'
export const RESTART_RCLONE = 'restart-rclone'

// Full lifecycle snapshot carried on a restart request. The main window may not have rehydrated
// the initiating webview's store writes yet, so the intended values ride along in the payload.
export interface RestartRclonePayload {
    rclonePath?: string
    defaultConfigPath?: string
    configFiles?: ConfigFile[]
    activeConfigId?: string | null
    proxy?: { url: string; ignoredHosts: string[] } | undefined
    // The config-sync intent + ownership marker, so the main window's post-restart reconcile uses
    // fresh values instead of not-yet-rehydrated (stale) ones from its own store.
    syncConfigToSystem?: boolean
    syncConfigLinkTarget?: string | null
}

// Deep-link payload forwarded from the main window to an already-open 'Templates' window
// (lib/deep.ts → src/pages/Templates.tsx). Not part of AppEventPayload: it targets a specific
// window via emitTo, not the main-window listeners.
export const ADD_TEMPLATE = 'add-template'

export interface AddTemplatePayload {
    cmd?: string
    name?: string
}

export type AppEventPayload = {
    [CLOSE_APP]: undefined
    [RELAUNCH_APP]: undefined
    [RESTART_RCLONE]: RestartRclonePayload
}

// Emit an app-lifecycle event. Tauri's window.emit broadcasts globally, so the single main-window
// listener receives it regardless of which webview calls this.
export async function emitToMain<E extends keyof AppEventPayload>(
    event: E,
    payload?: AppEventPayload[E]
): Promise<void> {
    await getCurrentWindow().emit(event, payload)
}
