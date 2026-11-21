import { t } from '@lingui/core/macro'
import { refusedFields } from '../../../lib/errors'
import { filenApiKey } from '../../../lib/remotes'
import { prompt } from '../../../lib/shell'

/**
 * The core's message about the two-factor code, when it needs one. The core asks for the code by
 * refusing the `code` field. Returns undefined when the core didn't ask.
 */
function codeAsked(error: unknown): string | undefined {
    return refusedFields(error).code
}

/**
 * Gets the account's API key, in the same way as `filen export-api-key`. Asks for the two-factor
 * code when the account needs one. Resolves null when the user cancels that prompt, or leaves it
 * empty.
 */
export async function generateFilenApiKey({
    email,
    password,
}: {
    email: string
    password: string
}): Promise<string | null> {
    let code = ''
    for (;;) {
        try {
            return await filenApiKey(email, password, code)
        } catch (error) {
            const reason = codeAsked(error)
            if (reason === undefined) throw error
            const asked = await prompt({
                title: t`Two-factor code`,
                message: reason || t`Enter the code from your authenticator app.`,
                default: '',
                sensitive: false,
            })
            const entered = asked?.trim()
            if (!entered) return null
            code = entered
        }
    }
}
