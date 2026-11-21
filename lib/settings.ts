import { t } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import { settings as api } from './core/api'
import { coreKey } from './core/query'
import { onErrorDialog } from './errors'
import type {
    Patch,
    Settings,
} from './shell/bindings/github.com/rclone/rclone-ui/core/settings/models'

export { TrayIcon } from './shell/bindings/github.com/rclone/rclone-ui/core/settings/models'
export type { Patch, Settings }

/** settings.changed keeps the query fresh. */
export function useSettings() {
    const query = useQuery({ queryKey: coreKey('settings', 'Get'), queryFn: () => api.Get() })
    return { settings: query.data, ...query }
}

/**
 * Writes the settings that a patch sets, such as `{ hideStartup: true }` or a whole proxy. Other
 * settings keep their values. It leaves errors to the caller. In the result, `restartRequired`
 * means part of the change applies only after the app restarts. settings.changed then brings
 * every window up to date.
 */
export function updateSettings(patch: Patch) {
    return api.Update(patch)
}

/**
 * Writes a patch (updateSettings) for a control that only sets a value, and shows an error in a
 * dialog.
 */
export function saveSettings(patch: Patch): void {
    api.Update(patch).catch(onErrorDialog(t`Settings not saved`))
}

/** Makes one request through a proxy, without saving it, and describes the result. */
export function testProxy(url: string): Promise<string> {
    return api.TestProxy(url)
}
