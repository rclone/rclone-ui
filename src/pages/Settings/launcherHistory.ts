import { launcher as api } from '../../../lib/core/api'

/** Deletes the launcher's history, which ranks its results by what was picked before. */
export async function forgetLauncherHistory(): Promise<void> {
    await api.Forget('')
}
