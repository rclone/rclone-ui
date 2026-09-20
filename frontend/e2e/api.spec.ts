import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, request as playwrightRequest, test } from '@playwright/test'
import { SERVER_BIN, SESSION, signIn, stopLeftoverJobs } from './helpers'

// The wire: RPC dispatch, the rc proxy, signed downloads, the API guard, the metadata mapper.

// What a test’s page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
test.afterEach(({ request }) => stopLeftoverJobs(request))

test('rpc round trip: the table, its arguments and its errors', async ({ request }) => {
    const cron = await (
        await request.post('/api/rpc/scheduler_validate_cron', {
            headers: SESSION,
            data: { cron: '0 2 * * *' },
        })
    ).json()
    expect(cron).toMatchObject({ ok: true, value: { valid: true } })

    const logged = await (
        await request.post('/api/rpc/log', {
            headers: SESSION,
            data: { level: 'debug', message: 'e2e round trip' },
        })
    ).json()
    expect(logged.ok).toBe(true)

    // An address of no platform the link service knows: answered here, with nothing asked of it.
    const plain = await (
        await request.post('/api/rpc/resolve_link', {
            headers: SESSION,
            data: { url: 'https://example.com/archive.zip?from=youtube.com' },
        })
    ).json()
    expect(plain).toEqual({ ok: true, value: null })

    const unknown = await (
        await request.post('/api/rpc/nope', { headers: SESSION, data: {} })
    ).json()
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('unknown command')

    const noSession = await request.post('/api/rpc/scheduler_supported', {
        headers: { 'Content-Type': 'application/json' },
        data: {},
    })
    expect(noSession.status()).toBe(400)
})

test('the reconnect prompt is claimed one at a time, and per remote', async ({ request }) => {
    const call = async (name: string, remote: string) =>
        (await (
            await request.post(`/api/rpc/${name}`, { headers: SESSION, data: { remote } })
        ).json()) as { ok: boolean; value?: boolean; error?: string }

    // An expired token fails every call that touches the remote, and each page would ask. The
    // first to ask gets the dialog; the pages behind it stay quiet.
    expect((await call('claim_reconnect_dialog', 'e2e-recon')).value).toBe(true)
    expect((await call('claim_reconnect_dialog', 'e2e-recon')).value).toBe(false)

    // Another remote is its own dialog: its token expires on its own schedule.
    expect((await call('claim_reconnect_dialog', 'e2e-recon-two')).value).toBe(true)

    // Once that dialog is done with, the next expiry can ask again — a remote reconnected today
    // expires again later, and a prompt that never came back would leave it failing silently.
    expect((await call('release_reconnect_dialog', 'e2e-recon')).ok).toBe(true)
    expect((await call('claim_reconnect_dialog', 'e2e-recon')).value).toBe(true)

    await call('release_reconnect_dialog', 'e2e-recon')
    await call('release_reconnect_dialog', 'e2e-recon-two')
})

test('a malformed transfer is refused, not started as an empty one', async () => {
    const base = 'http://127.0.0.1:5612'
    const request = await playwrightRequest.newContext({ baseURL: base })
    await signIn(request, base)
    const reply = (await (
        await request.post('/api/rpc/transfers_start', {
            headers: SESSION,
            data: { transfer: 'nope' },
        })
    ).json()) as { ok: boolean; error?: string }
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain("invalid 'transfer'")
    await request.dispose()
})

test('the rc proxy reaches the daemon and streams file bytes', async ({ request }) => {
    const version = await request.post('/api/rc/core/version', { headers: SESSION, data: {} })
    expect(version.ok()).toBe(true)
    expect(((await version.json()) as { version: string }).version).toMatch(/^v\d/)

    // Upload through the proxy (multipart), then read it back with a Range through --rc-serve.
    const upload = await request.post('/api/rc/operations/uploadfile?fs=e2e-memory:&remote=dir', {
        headers: { 'X-RcloneCloud-Client': 'web' },
        multipart: {
            file0: {
                name: 'hello.txt',
                mimeType: 'text/plain',
                buffer: Buffer.from('hello world'),
            },
        },
    })
    expect(upload.ok()).toBe(true)
    const partial = await request.get('/api/rc/[e2e-memory:]/dir/hello.txt', {
        headers: { 'X-RcloneCloud-Client': 'web', Range: 'bytes=0-4' },
    })
    expect(partial.status()).toBe(206)
    expect(await partial.text()).toBe('hello')

    const link = await (
        await request.post('/api/rpc/download_link', {
            headers: SESSION,
            data: { fs: 'e2e-memory:', remote: 'dir/hello.txt' },
        })
    ).json()
    expect(link.ok).toBe(true)
    // Signed links need no session: the token is the credential.
    const download = await request.get(link.value as string, { headers: {} })
    expect(download.ok()).toBe(true)
    expect(download.headers()['content-disposition']).toContain('attachment')
    expect(await download.text()).toBe('hello world')

    // There is one daemon and no host to name, so the whole path is rclone's: an endpoint it
    // does not have is rclone's own 404, not the proxy refusing to route.
    expect(
        (await request.post('/api/rc/nope/core/version', { headers: SESSION, data: {} })).status()
    ).toBe(404)
})

test('asset-like file names never bypass the API guard', async ({ request }) => {
    // Both external-daemon servers share the rclone daemon: upload through the open one, then
    // ask the password-protected one for the file without a session. The proxy injects the
    // daemon's credentials, so it must refuse whatever the file is called.
    const upload = await request.post('/api/rc/operations/uploadfile?fs=e2e-memory:&remote=guard', {
        headers: { 'X-RcloneCloud-Client': 'web' },
        multipart: {
            file0: {
                name: 'secret.png',
                mimeType: 'image/png',
                buffer: Buffer.from('not a picture'),
            },
        },
    })
    expect(upload.ok()).toBe(true)

    const base = 'http://127.0.0.1:5611'
    for (const path of [
        '/api/rc/[e2e-memory:]/guard/secret.png',
        '/api/rc/[e2e-memory:]/guard/secret.txt',
    ]) {
        const response = await request.get(`${base}${path}`)
        expect(response.status(), path).toBe(401)
    }
    const put = await request.put(`${base}/api/state/app.png`, {
        headers: SESSION,
        data: { version: 1, state: { a: 1 } },
    })
    expect(put.status()).toBe(401)
})

test('rclone runs the app itself as its metadata mapper', async ({ request }) => {
    // The whole contract with rclone in one call: `_config.MetadataMapper` only accepts an argv
    // ARRAY (a string is rejected outright, and the macOS binary's path has a space in it), the
    // daemon spawns whatever argv[0] names, and what that program prints is what gets written.
    // `Metadata: true` is not optional — without it rclone never calls the mapper at all.
    const dir = resolve('e2e/.tmp/mapper')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'hello')

    const response = await request.post('/api/rc/operations/copyfile', {
        headers: SESSION,
        data: {
            srcFs: dir,
            srcRemote: 'a.txt',
            dstFs: join(dir, 'out'),
            dstRemote: 'a.txt',
            _config: {
                Metadata: true,
                MetadataMapper: [SERVER_BIN, 'metadata-map', '--set', 'mtime=2001-02-03T04:05:06Z'],
            },
        },
    })
    expect(await response.text()).toBe('{}\n')

    // A constant no source file could have had: it can only come from our own program's stdout.
    expect(statSync(join(dir, 'out', 'a.txt')).mtime.toISOString()).toBe('2001-02-03T04:05:06.000Z')
})
