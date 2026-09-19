import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { APIRequestContext } from '@playwright/test'

// Every server in playwright.config.ts starts with `--password e2e-secret`, which seeds the
// owner account on the first start.
export const OWNER = { email: 'admin@localhost', password: 'e2e-secret' }

/**
 * The debug binary, from `cargo build -p rclone-cloud`. Anchored to this file rather than to
 * the working directory: the Cargo target sits at the repo root while the suite runs from
 * frontend, and the specs that start a server of their own spawn it themselves.
 */
export const SERVER_BIN = fileURLToPath(new URL('../../target/debug/rclone-cloud', import.meta.url))

/** Signs a request context in (its pages share the cookie jar), as the owner unless told otherwise. */
export async function signIn(
    api: APIRequestContext,
    base = '',
    credentials = OWNER
): Promise<void> {
    const response = await api.post(`${base}/api/login`, { data: credentials })
    if (!response.ok()) {
        throw new Error(`sign-in at ${base || 'the base URL'} failed with ${response.status()}`)
    }
}

export interface ReceivedMail {
    from: string
    to: string[]
    /** The message as sent after DATA: headers, a blank line, the body. */
    message: string
}

/**
 * A mail server with no TLS, for the SMTP settings to point at: it answers the way a relay
 * does (EHLO, MAIL, RCPT, DATA, QUIT) and keeps every message it is handed. One session at a
 * time is all the app ever opens.
 */
export async function smtpReceiver(): Promise<{
    host: string
    port: number
    received: ReceivedMail[]
    close: () => void
}> {
    const received: ReceivedMail[] = []
    const server = createServer((socket) => {
        let from = ''
        let to: string[] = []
        let message = ''
        let inData = false
        let buffered = ''
        socket.write('220 e2e ESMTP\r\n')
        socket.on('data', (chunk) => {
            buffered += chunk.toString('utf8')
            let end = buffered.indexOf('\r\n')
            while (end !== -1) {
                const line = buffered.slice(0, end)
                buffered = buffered.slice(end + 2)
                end = buffered.indexOf('\r\n')
                if (inData) {
                    if (line === '.') {
                        inData = false
                        received.push({ from, to, message })
                        socket.write('250 queued\r\n')
                    } else {
                        message += `${line.startsWith('..') ? line.slice(1) : line}\r\n`
                    }
                    continue
                }
                const upper = line.toUpperCase()
                if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
                    socket.write('250-e2e\r\n250 OK\r\n')
                } else if (upper.startsWith('MAIL FROM:')) {
                    from = line.slice('MAIL FROM:'.length).trim().replace(/^<|>$/g, '')
                    to = []
                    message = ''
                    socket.write('250 OK\r\n')
                } else if (upper.startsWith('RCPT TO:')) {
                    to.push(line.slice('RCPT TO:'.length).trim().replace(/^<|>$/g, ''))
                    socket.write('250 OK\r\n')
                } else if (upper.startsWith('DATA')) {
                    inData = true
                    socket.write('354 go ahead\r\n')
                } else if (upper.startsWith('QUIT')) {
                    socket.end('221 bye\r\n')
                } else {
                    socket.write('250 OK\r\n')
                }
            }
        })
        socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    return { host: '127.0.0.1', port, received, close: () => server.close() }
}

/**
 * Stops the jobs a test's page left running on the shared daemon. A picker or the Commander
 * sizes the folders it lists, each as a job that walks the folder's whole tree, and a page stops
 * its own as it goes away (`pagehide`). A page Playwright tears down never gets to: opened on
 * the home directory, its jobs went on walking the disk for minutes (millions of entries) under
 * every test that followed, which is where this suite's "fails only in a full run" came from.
 */
export async function stopLeftoverJobs(api: APIRequestContext): Promise<void> {
    const daemon = 'http://localhost:5572'
    try {
        const list = (await (await api.post(`${daemon}/job/list`, { data: {} })).json()) as {
            runningIds?: number[]
        }
        await Promise.all(
            (list.runningIds ?? []).map((jobid) =>
                api.post(`${daemon}/job/stop`, { data: { jobid } }).catch(() => null)
            )
        )
    } catch {
        // The daemon is not there to have anything running.
    }
}
