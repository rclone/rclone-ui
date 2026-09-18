// rclone's config is an INI file the app owns for its managed daemon; a remote is one section.
// Pure text helpers, so a rename can edit the file in place (rclone re-reads a config whose
// modification time changed) instead of creating the remote again through the rc API.

/** rclone writes this marker into a config it encrypted; there are no sections to find then. */
export const ENCRYPTED_CONFIG_MARKER = 'RCLONE_ENCRYPT_V0:'

const header = (line: string) => line.replace(/\r$/, '').trim()

/** The config text with the `[from]` section renamed to `[to]`, everything else byte for byte. */
export function renameConfigSection(text: string, from: string, to: string): string {
    const lines = text.split('\n')
    if (lines.some((line) => header(line) === `[${to}]`)) {
        throw new Error(`The config already has a section called ${to}.`)
    }
    const index = lines.findIndex((line) => header(line) === `[${from}]`)
    if (index < 0) throw new Error(`The config has no section called ${from}.`)
    lines[index] = lines[index].replace(`[${from}]`, `[${to}]`)
    return lines.join('\n')
}
