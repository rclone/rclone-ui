import * as Sentry from '@sentry/browser'

import { selectActiveConfigFile, useHostStore } from '../../store/host'
import { usePersistedStore } from '../../store/persisted'
import type { ConfigFile } from '../../types/config'
import { getConfigParentFolder } from '../format'
import { getConfigPath } from './common'
import { restartRclone } from '../api/app'
import { message, prompt } from '../api/dialog'
import { sep } from '../api/paths'
import { rpc } from '../api/rpc'

interface ExecResult {
    code: number | null
    stdout: string
    stderr: string
}

export interface RcloneCliCommandContext {
    rclonePath: string
    args: string[]
    activeConfig: ConfigFile
    configPath: string
    configDirectory: string
    env: Record<string, string>
}

export async function promptForConfigPassword(text: string) {
    console.log('[promptForConfigPassword] message:', text)
    try {
        const result = await prompt({
            title: 'Rclone UI',
            message: text.replace(/"/g, '“'),
            default: null,
            sensitive: true,
        })
        console.log('[promptForConfigPassword] received result type:', typeof result)

        if (typeof result === 'string') {
            console.log('[promptForConfigPassword] password received, length:', result.length)
            return result
        }

        console.log('[promptForConfigPassword] no password received (cancelled or empty)')
        return null
    } catch (error) {
        console.error('[promptForConfigPassword] Error prompting for password:', error)
        return null
    }
}

/** Returns the active rclone binary path (set during startup adoption). */
export function getActiveRclonePath(): string {
    const path = usePersistedStore.getState().rclonePath
    if (!path) {
        throw new Error('No rclone binary is configured.')
    }
    return path
}

async function validateConfigAccess(
    rclonePath: string,
    env: Record<string, string>,
    timeoutMs: number | null = 15000
): Promise<{
    success: boolean
    timedOut?: boolean
    code?: number | null
    stderr?: string
    error?: Error
}> {
    console.log('[validateConfigAccess] rclone:', rclonePath)
    try {
        const result = await rpc<ExecResult>('exec_rclone', {
            path: rclonePath,
            args: ['config', 'dump'],
            env,
            stdinLines: null,
            timeoutMs,
        })
        console.log('[validateConfigAccess] exit code:', result.code)

        if (result.code === 0) {
            return { success: true }
        }

        return {
            success: false,
            // A null code means the probe was killed at the deadline — rclone never ruled on the
            // credentials, so callers must not treat this as a wrong password.
            timedOut: result.code === null,
            code: result.code ?? null,
            stderr: result.stderr,
        }
    } catch (error) {
        console.error('[validateConfigAccess] execution error:', error)
        return {
            success: false,
            error: error instanceof Error ? error : new Error(String(error)),
        }
    }
}

export async function ensureEncryptedConfigEnv(
    activeConfig: ConfigFile,
    env: Record<string, string>,
    autoPromptForPassword: boolean,
    rclonePath: string,
    promptMessage: string
) {
    console.log('[ensureEncryptedConfigEnv] ensuring encrypted config env for:', activeConfig.id)

    env.RCLONE_ASK_PASSWORD = 'false'

    if (activeConfig.passCommand) {
        console.log('[ensureEncryptedConfigEnv] using passCommand for decryption')
        const validationEnv = {
            ...env,
            RCLONE_CONFIG_PASS_COMMAND: activeConfig.passCommand,
        }

        // Password commands can block on user interaction (biometric prompt, pinentry), so this
        // probe must not have a deadline.
        const validation = await validateConfigAccess(rclonePath, validationEnv, null)
        if (validation.success) {
            console.log('[ensureEncryptedConfigEnv] passCommand validation succeeded')
            env.RCLONE_CONFIG_PASS_COMMAND = activeConfig.passCommand
            return
        }

        console.error('[ensureEncryptedConfigEnv] passCommand validation failed', validation.code)
        await message(
            'Failed to decrypt the configuration using the configured password command. Please verify the command output.',
            {
                title: 'Password Command Failed',
                kind: 'error',
                okLabel: 'OK',
            }
        )
        throw new Error('Failed to decrypt configuration using pass command.')
    }

    let password = activeConfig.pass ?? undefined
    let passwordSource: 'stored' | 'prompted' | null = password ? 'stored' : null

    const hostStore = useHostStore.getState()
    const updateConfigFile = hostStore.updateConfigFile
    const activeConfigId = activeConfig.id

    if (!password && !autoPromptForPassword) {
        throw new Error('Password required to access encrypted configuration.')
    }

    while (true) {
        if (!password) {
            if (!autoPromptForPassword) {
                throw new Error('Password required to access encrypted configuration.')
            }

            const promptedPassword = await promptForConfigPassword(promptMessage)
            console.log('[ensureEncryptedConfigEnv] password received:', !!promptedPassword)

            if (!promptedPassword) {
                console.log('[ensureEncryptedConfigEnv] password prompt cancelled by user')
                throw new Error('Password prompt cancelled by user.')
            }

            password = promptedPassword
            passwordSource = 'prompted'
        }

        const validationEnv = {
            ...env,
            RCLONE_CONFIG_PASS: password,
        }

        const validation = await validateConfigAccess(rclonePath, validationEnv)
        if (validation.success) {
            console.log('[ensureEncryptedConfigEnv] password validation succeeded')
            env.RCLONE_CONFIG_PASS = password
            return
        }

        console.error('[ensureEncryptedConfigEnv] password validation failed', validation.code)

        if (validation.timedOut || validation.error) {
            // Indeterminate result (probe killed at its deadline, or rclone failed to launch) —
            // the password may well be correct, so never clear a stored one or reprompt over it.
            throw new Error(
                validation.error
                    ? `Could not verify the configuration password: ${validation.error.message}`
                    : 'Timed out while verifying the configuration password. Please try again.'
            )
        }

        if (passwordSource === 'stored') {
            console.log('[ensureEncryptedConfigEnv] clearing invalid stored password')
            if (activeConfigId && updateConfigFile) {
                try {
                    updateConfigFile(activeConfigId, { pass: undefined })
                    console.log('[ensureEncryptedConfigEnv] stored password cleared')
                } catch (error) {
                    Sentry.captureException(error)
                    console.error(
                        '[ensureEncryptedConfigEnv] failed to clear stored password',
                        error
                    )
                }
            }

            await message(
                'The saved password for this configuration appears to be incorrect. You will be prompted for a new password.',
                {
                    title: 'Invalid Password',
                    kind: 'error',
                    okLabel: 'OK',
                }
            )

            password = undefined
            passwordSource = null
            continue
        }

        if (!autoPromptForPassword) {
            throw new Error('Password required to access encrypted configuration.')
        }

        const response = await message('Incorrect password. Please try again.', {
            title: 'Invalid Password',
            kind: 'error',
            buttons: {
                ok: 'Try Again',
                cancel: 'Cancel',
            },
        })

        if (response !== 'Try Again') {
            console.log('[ensureEncryptedConfigEnv] user cancelled password retry')
            throw new Error('Password prompt cancelled by user.')
        }

        password = undefined
        passwordSource = null
    }
}

/**
 * Builds the environment map for running rclone: proxy vars, config location (always set to the
 * resolved config path), and encrypted-config credentials. Shared by the daemon and one-off CLI.
 */
export async function buildRcloneEnv(opts: {
    activeConfig: ConfigFile
    configDirectory: string
    configPath: string
    proxy?: { url: string; ignoredHosts: string[] } | undefined
    rclonePath: string
    autoPromptForPassword?: boolean
    additionalEnv?: Record<string, string>
}): Promise<Record<string, string>> {
    const env: Record<string, string> = {}

    if (opts.proxy?.url) {
        env.http_proxy = opts.proxy.url
        env.https_proxy = opts.proxy.url
        env.HTTP_PROXY = opts.proxy.url
        env.HTTPS_PROXY = opts.proxy.url
        env.no_proxy = opts.proxy.ignoredHosts.join(',')
        env.NO_PROXY = opts.proxy.ignoredHosts.join(',')
    }

    // Always pin the config location. For a system + default-config user this equals rclone's own
    // default (explicit = default), and for managed/custom it prevents falling back to a wrong path.
    env.RCLONE_CONFIG_DIR = opts.configDirectory
    env.RCLONE_CONFIG = opts.configPath.endsWith('rclone.conf')
        ? opts.configPath
        : `${opts.configDirectory}${sep}rclone.conf`

    if (opts.activeConfig.isEncrypted) {
        await ensureEncryptedConfigEnv(
            opts.activeConfig,
            env,
            opts.autoPromptForPassword ?? true,
            opts.rclonePath,
            `Please enter the current password for "${opts.activeConfig.label}"`
        )
    }

    if (opts.additionalEnv) {
        Object.assign(env, opts.additionalEnv)
    }

    return env
}

async function createRcloneCliCommand(
    args: string[],
    additionalEnv?: Record<string, string>,
    autoPromptForPassword = true
): Promise<RcloneCliCommandContext> {
    console.log('[createRcloneCliCommand] creating rclone CLI command with args:', args)
    const hostStore = useHostStore.getState()
    const activeConfig = selectActiveConfigFile(hostStore)

    if (!activeConfig || !activeConfig.id) {
        throw new Error('No active configuration selected.')
    }

    const rclonePath = getActiveRclonePath()

    let configPath: string
    try {
        configPath = await getConfigPath({ id: activeConfig.id, validate: true })
    } catch (error) {
        Sentry.captureException(error)
        throw error
    }

    const configDirectory = getConfigParentFolder(configPath)
    console.log('[createRcloneCliCommand] config directory:', configDirectory)

    const env = await buildRcloneEnv({
        activeConfig,
        configDirectory,
        configPath,
        proxy: hostStore.proxy,
        rclonePath,
        autoPromptForPassword,
        additionalEnv,
    })

    return {
        rclonePath,
        args,
        activeConfig,
        configPath,
        configDirectory,
        env,
    }
}

export async function runRcloneCli(args: string[], input: string[] = []) {
    const { rclonePath, env } = await createRcloneCliCommand(args, undefined, true)

    console.log('[runRcloneCli] running command', 'args:', args, 'input:', input)

    let result: ExecResult
    try {
        result = await rpc<ExecResult>('exec_rclone', {
            path: rclonePath,
            args,
            env,
            stdinLines: input.length > 0 ? input : null,
            // Config-writing operations must not be interrupted by a timeout.
            timeoutMs: null,
        })
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        Sentry.captureException(err)
        throw err
    }

    if (result.code !== 0) {
        const error = new Error(
            `rclone command failed (code ${result.code ?? 'unknown'}): ${result.stderr || result.stdout}`
        )
        Sentry.captureException(error)
        throw error
    }
}

/** Asks the orchestrator to restart the daemon with a full lifecycle snapshot. Returns false if
 * the request could not even be sent, so callers can roll back optimistic state on failure. */
export async function restartActiveRclone(): Promise<boolean> {
    try {
        // The orchestrator's view of the state may lag this page's writes — carry a full
        // lifecycle snapshot from THIS page's fresh stores in the request.
        const host = useHostStore.getState()
        const persisted = usePersistedStore.getState()
        await restartRclone({
            rclonePath: persisted.rclonePath,
            defaultConfigPath: host.defaultConfigPath,
            configFiles: host.configFiles,
            activeConfigId: host.activeConfigId,
            proxy: host.proxy,
            syncConfigToSystem: host.syncConfigToSystem,
            syncConfigLinkTarget: host.syncConfigLinkTarget,
        })
        return true
    } catch (error) {
        Sentry.captureException(error)
        console.error('[restartActiveRclone] failed to request a restart', error)
        return false
    }
}
