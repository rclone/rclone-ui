import { launcher as api } from '../../../lib/core/api'

export async function forgetLauncherHistory(): Promise<void> {
    await api.Forget('')
}
