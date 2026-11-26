import { t } from '@lingui/core/macro'
import { refusedFields } from '../../../lib/errors'
import { filenApiKey } from '../../../lib/remotes'
import { prompt } from '../../../lib/shell'

function codeAsked(error: unknown): string | undefined {
    return refusedFields(error).code
}

export async function generateFilenApiKey({
    email,
    password,
}: {
    email: string
    password: string
}): Promise<string | null> {
    let code = ''
    while (true) {
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
