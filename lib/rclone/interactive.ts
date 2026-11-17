import { invoke } from '@tauri-apps/api/core'
import { message } from '@tauri-apps/plugin-dialog'
import type { ConfigStep } from 'rclone-sdk'
import type { BackendOption } from '../../types/rclone'
import { UserCancelledError } from '../errors'
import rclone from './client'

const PROMPT_TITLE = 'Configure remote'

async function nativePrompt(args: {
    message: string
    default?: string | null
    sensitive?: boolean
}): Promise<string | null> {
    try {
        const result = await invoke<string | null>('prompt', {
            title: PROMPT_TITLE,
            message: args.message,
            default: args.default ?? null,
            sensitive: args.sensitive ?? false,
        })
        return typeof result === 'string' ? result : null
    } catch (error) {
        console.error('[interactive] native prompt failed', error)
        return null
    }
}

function firstLine(text: string): string {
    return (text.split('\n')[0] ?? '').trim()
}

function defaultString(option: BackendOption): string {
    if (option.Default !== undefined && option.Default !== null) return String(option.Default)
    return option.DefaultStr ?? ''
}

const YES = new Set(['y', 'yes', 'true', '1'])
const NO = new Set(['n', 'no', 'false', '0'])

// Maps one config-machine question (rclone `Option`) onto the native text prompt and returns the
// `result` string to send back — or null if the user cancelled. Because the dialog is text-only:
//   - bool  -> ask for y/n, return "true"/"false"
//   - choice (Examples) -> render a numbered list, return the chosen example's *Value* (not the
//     ordinal). Exclusive lists require a valid number; non-exclusive ones also accept free text.
//   - plain -> a single text field (masked when the option is a password/secret)
export async function promptForConfigOption(option: BackendOption): Promise<string | null> {
    const help = (option.Help || option.Name || '').trim()
    const def = defaultString(option)

    if (option.Type === 'bool') {
        const message = `${help}\n\n(type y or n)`
        const boolDefault = def === 'true' ? 'y' : 'n'
        while (true) {
            const answer = await nativePrompt({ message, default: boolDefault })
            if (answer === null) return null
            const norm = answer.trim().toLowerCase()
            if (YES.has(norm)) return 'true'
            if (NO.has(norm)) return 'false'
            // invalid → re-ask
        }
    }

    const examples = option.Examples ?? []
    if (examples.length > 0) {
        const lines = examples.map((ex, i) => {
            const label = ex.Help ? `${ex.Value} — ${firstLine(ex.Help)}` : ex.Value
            return `${i + 1}) ${label}`
        })
        const message = `${help}\n\n${lines.join('\n')}\n\nEnter a number:`
        const defaultIndex = examples.findIndex((ex) => ex.Value === def)
        const defaultNumber = defaultIndex >= 0 ? String(defaultIndex + 1) : '1'
        while (true) {
            const answer = await nativePrompt({ message, default: defaultNumber })
            if (answer === null) return null
            const trimmed = answer.trim()
            const n = Number.parseInt(trimmed, 10)
            if (Number.isInteger(n) && n >= 1 && n <= examples.length) {
                return examples[n - 1].Value
            }
            // A fixed/exclusive list must match a number; a free-form list accepts a typed value.
            if (!option.Exclusive && trimmed !== '') return trimmed
            // invalid → re-ask
        }
    }

    return nativePrompt({
        message: help,
        default: def,
        sensitive: option.IsPassword || option.Sensitive,
    })
}

async function callCreate(
    name: string,
    type: string,
    parameters: Record<string, unknown>,
    opt: Record<string, unknown>
): Promise<ConfigStep> {
    const data = await rclone('/config/create', {
        params: {
            query: {
                name,
                type,
                parameters: JSON.stringify(parameters),
                opt: JSON.stringify(opt),
            },
        },
    })
    // The SDK types this response as an empty object; the daemon actually returns the ConfigOut.
    return data as unknown as ConfigStep
}

async function safeDeleteRemote(name: string): Promise<void> {
    try {
        await rclone('/config/delete', { params: { query: { name } } })
    } catch (error) {
        console.error('[interactive] failed to clean up partial remote', name, error)
    }
}

// drives the RC config state machine to completion.
export async function createRemoteInteractive({
    name,
    type,
    parameters,
}: {
    name: string
    type: string
    parameters: Record<string, unknown>
}): Promise<string> {
    try {
        let step = await callCreate(name, type, parameters, {
            nonInteractive: true,
            obscure: true,
        })

        while (step.State !== '') {
            if (step.Option) {
                const answer = await promptForConfigOption(step.Option)
                if (answer === null) {
                    await safeDeleteRemote(name)
                    throw new UserCancelledError('Remote creation cancelled')
                }
                step = await callCreate(
                    name,
                    type,
                    {},
                    { nonInteractive: true, continue: true, state: step.State, result: answer }
                )
                continue
            }

            if (step.Error) {
                // Soft error (e.g. a search returned no results): show it, then re-enter the state
                // rclone pointed back to, which will present the next question.
                await message(step.Error, { title: 'Configuration', kind: 'error' })
                step = await callCreate(
                    name,
                    type,
                    {},
                    {
                        nonInteractive: true,
                        continue: true,
                        state: step.State,
                        result: step.Result ?? '',
                    }
                )
                continue
            }

            // Non-empty state with neither a question nor an error shouldn't happen (the daemon
            // follows such transitions internally) — bail rather than spin.
            console.warn('[interactive] unexpected step with no option/error', step)
            break
        }
    } catch (error) {
        if (error instanceof UserCancelledError) throw error
        // Mid-flow failure (e.g. a rejected token surfaced as a 500)
        // clean up the partial remote
        // before surfacing the error to the caller's onError handler.
        await safeDeleteRemote(name)
        throw error
    }

    return name
}
