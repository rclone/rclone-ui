import rclone from './client'
import { ENCRYPTED_CONFIG_MARKER } from './config-text'
import { readFile, writeFile } from './daemon-fs'

// The config file the daemon runs with, read and written through the daemon (`daemon-fs.ts`);
// rclone re-reads a config whose modification time changed.

export interface DaemonConfig {
    path: string
    text: string
    /** rclone encrypted it: there is no text to edit. */
    encrypted: boolean
}

/** Where the daemon keeps its config file, on the daemon's machine. */
export async function daemonConfigPath(): Promise<string> {
    const paths = (await rclone('/config/paths')) as { config?: string } | undefined
    if (!paths?.config) throw new Error('rclone did not say where its config file is.')
    return paths.config
}

export async function readDaemonConfig(): Promise<DaemonConfig> {
    const path = await daemonConfigPath()
    const text = await readFile(path)
    return { path, text, encrypted: text.includes(ENCRYPTED_CONFIG_MARKER) }
}

export async function writeDaemonConfig(text: string): Promise<void> {
    await writeFile(await daemonConfigPath(), text)
}
