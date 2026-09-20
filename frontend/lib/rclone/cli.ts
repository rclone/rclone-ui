import * as Sentry from '@sentry/browser'

import { useHostStore } from '../../store/host'
import { restartRclone } from '../api/app'

/** Asks the orchestrator to restart the daemon with a fresh snapshot of what it needs. Returns
 * false if the request could not even be sent, so callers can roll back optimistic state on
 * failure.
 *
 * The snapshot carries the proxy and the limits. Which binary runs is the server's alone to write
 * (`rclone_set_custom`, `rclone_install`), and rclone resolves its own configuration file. */
export async function restartActiveRclone(): Promise<boolean> {
    try {
        // The orchestrator's view of the state may lag this page's writes — carry the values from
        // THIS page's fresh stores in the request.
        const host = useHostStore.getState()
        await restartRclone({ proxy: host.proxy, limits: host.limits })
        return true
    } catch (error) {
        Sentry.captureException(error)
        console.error('[restartActiveRclone] failed to request a restart', error)
        return false
    }
}
