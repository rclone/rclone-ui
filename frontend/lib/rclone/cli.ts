import * as Sentry from '@sentry/browser'

import { useHostStore } from '../../store/host'
import { usePersistedStore } from '../../store/persisted'
import { restartRclone } from '../api/app'

/** Asks the orchestrator to restart the daemon with a fresh snapshot of what it needs. Returns
 * false if the request could not even be sent, so callers can roll back optimistic state on
 * failure.
 *
 * The snapshot carries the binary and the proxy, and nothing about rclone's configuration file:
 * the daemon inherits the server's environment and rclone resolves its own config. */
export async function restartActiveRclone(): Promise<boolean> {
    try {
        // The orchestrator's view of the state may lag this page's writes — carry the values from
        // THIS page's fresh stores in the request.
        const host = useHostStore.getState()
        const persisted = usePersistedStore.getState()
        await restartRclone({
            rclonePath: persisted.rclonePath,
            proxy: host.proxy,
        })
        return true
    } catch (error) {
        Sentry.captureException(error)
        console.error('[restartActiveRclone] failed to request a restart', error)
        return false
    }
}
