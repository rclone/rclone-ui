import { t } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import { config as api } from './core/api'
import { coreKey } from './core/query'
import { formatErrorMessage } from './errors'
import { ask, message, prompt } from './shell'
import {
    type ConfigFile,
    Status as ConfigStatus,
} from './shell/bindings/github.com/rclone/rclone-ui/core/config/models'

export type { ConfigFile }
export { ConfigStatus }

// The config file is rclone's own default file. config.changed refetches it, along with
// everything that depends on it.

export function useConfig() {
    return useQuery({ queryKey: coreKey('config', 'Get'), queryFn: () => api.Get() })
}

/**
 * Asks for a password, twice when it is a new one. Returns null when the user cancels or the two
 * entries differ.
 */
export async function promptPassword(
    text: string,
    { confirm = true } = {}
): Promise<string | null> {
    const title = t`Config Password`
    const password = await prompt({ title, message: text, sensitive: true })
    if (!password) return null
    if (!confirm) return password
    const again = await prompt({ title, message: t`Enter the password again.`, sensitive: true })
    if (again === null) return null
    if (again !== password) {
        await message(t`The passwords are not the same.`, { title, kind: 'error' })
        return null
    }
    return password
}

/**
 * Unlocks the config, which is encrypted and locked. Asks for the password until it is right or
 * the user gives up. After a wrong password, the core's reason shows above the question. Returns
 * true when the config was unlocked.
 */
export async function unlockConfig(): Promise<boolean> {
    const question = t`Your rclone config is encrypted. Enter the password to access it.`
    let refusal = ''
    while (true) {
        const password = await promptPassword(refusal ? `${refusal}\n\n${question}` : question, {
            confirm: false,
        })
        if (!password) return false
        try {
            await api.Unlock(password, false)
        } catch (error) {
            refusal = formatErrorMessage(error)
            continue
        }
        if (await askToRemember()) await api.Unlock(password, true)
        return true
    }
}

export function askToRemember(): Promise<boolean> {
    return ask(t`Save the password in the system keychain?`, {
        title: t`Config Password`,
        okLabel: t({
            message: 'Save',
            comment: "Button: keeps the config's password in the system keychain.",
        }),
        cancelLabel: t`Don't save`,
    })
}

/**
 * The config file's text, for the editor. A locked config is encrypted, so pass `enabled` false
 * until it is unlocked. The text isn't kept after the editor closes.
 */
export function useConfigText(enabled: boolean) {
    return useQuery({
        queryKey: coreKey('config', 'ReadText'),
        queryFn: () => api.ReadText(),
        enabled,
        gcTime: 0,
    })
}

/** Reads the config file's text as it is on disk now. */
export function readConfigText(): Promise<string> {
    return api.ReadText()
}

/** Replaces the config file's text. The core refuses text that rclone can't read. */
export async function writeConfigText(text: string): Promise<void> {
    await api.WriteText(text)
}

export async function exportConfig(path: string): Promise<void> {
    await api.Export(path)
}

/** Encrypts the config with a new password, and saves it in the keychain when `remember` is set. */
export async function setConfigPassword(password: string, remember: boolean): Promise<void> {
    await api.SetPassword(password, remember)
}

/** Removes the config's encryption. */
export async function removeConfigPassword(): Promise<void> {
    await api.RemovePassword()
}

/** Checks the config's current password and saves it in the keychain. */
export async function rememberConfigPassword(password: string): Promise<void> {
    await api.Unlock(password, true)
}

/** Sets the command that prints the config's password. An empty command removes it. */
export async function setPasswordCommand(command: string): Promise<void> {
    await api.SetPasswordCommand(command)
}

/** Forgets the config's password that the keychain holds. */
export async function forgetConfigPassword(): Promise<void> {
    await api.ForgetPassword()
}
