import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
    type BrowserContext,
    type Page,
    expect,
    request as playwrightRequest,
    test,
} from '@playwright/test'
import { OWNER, SERVER_BIN, SESSION, collectErrors, signIn, stopLeftoverJobs } from './helpers'

// The state documents: the server’s contract, and the page adapter against a stand-in held to it.

// What a test’s page left running on the shared daemon stops with the test (`stopLeftoverJobs`).
test.afterEach(({ request }) => stopLeftoverJobs(request))

// The server keeps two documents, and a live store sits on each, so the adapter's tests run
// against a stand-in. The server and the stand-in are held to this one contract.
interface StateDoc {
    version: number
    revision: number
    state: Record<string, unknown>
}

type StateCall = (
    method: 'GET' | 'PUT' | 'PATCH',
    data?: unknown,
    ifMatch?: string
) => Promise<{ status: number; body: StateDoc }>

async function stateContract(call: StateCall) {
    // Unwritten: revision 0, nothing in it.
    const fresh = await call('GET')
    expect(fresh.body).toMatchObject({ revision: 0, state: {} })

    // Created on the condition that nobody has yet; the second creation is refused and told
    // what is there.
    const created = await call('PUT', { version: 1, state: { a: 1, b: 'x' } }, '0')
    expect(created.status).toBe(200)
    expect(created.body).toEqual({ version: 1, revision: 1, state: { a: 1, b: 'x' } })
    const again = await call('PUT', { version: 1, state: { c: 3 } }, '0')
    expect(again.status).toBe(409)
    expect(again.body.state).toEqual({ a: 1, b: 'x' })

    const patched = await call('PATCH', { set: { b: 'y' } }, '1')
    expect(patched.status).toBe(200)
    expect(patched.body).toMatchObject({ revision: 2, state: { a: 1, b: 'y' } })
    const stale = await call('PATCH', { set: { b: 'z' } }, '1')
    expect(stale.status).toBe(409)
    expect(stale.body.state).toEqual({ a: 1, b: 'y' })

    const cleared = await call('PATCH', { set: {}, unset: ['a', 'neverThere'] }, '2')
    expect(cleared.body).toMatchObject({ revision: 3, state: { b: 'y' } })
    expect((await call('GET')).body).toEqual(cleared.body)

    // A malformed precondition is refused, not treated as none.
    expect((await call('PATCH', { set: { x: 1 }, unset: [] }, 'abc')).status).toBe(400)
    // Without one the write is unconditional.
    const replaced = await call('PUT', { version: 1, state: {} })
    expect(replaced.body).toMatchObject({ revision: 4, state: {} })
}

/** One document of the state API, in memory, answering `/api/state/<name>` for a context's pages. */

function stateStandIn(name: string) {
    let doc: StateDoc = { version: 1, revision: 0, state: {} }
    const call: StateCall = async (method, data, ifMatch) => {
        if (method === 'GET') return { status: 200, body: doc }
        if (ifMatch !== undefined && !/^\d+$/.test(ifMatch)) return { status: 400, body: doc }
        if (ifMatch !== undefined && Number(ifMatch) !== doc.revision) {
            return { status: 409, body: doc }
        }
        const body = data as Partial<StateDoc> & { set?: StateDoc['state']; unset?: string[] }
        const state = method === 'PUT' ? body.state! : { ...doc.state, ...body.set }
        for (const key of body.unset ?? []) delete state[key]
        doc = { version: body.version ?? doc.version, revision: doc.revision + 1, state }
        return { status: 200, body: doc }
    }
    const serve = (context: BrowserContext) =>
        context.route(`**/api/state/${name}`, async (route) => {
            const asked = route.request()
            const reply = await call(
                asked.method() as 'GET',
                asked.postDataJSON() ?? undefined,
                asked.headers()['if-match']
            )
            await route.fulfill({ status: reply.status, json: reply.body })
        })
    return { name, call, serve, state: () => doc.state }
}

test('the state API keeps its contract, and knows its two documents only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcui-e2e-state-'))
    const base = 'http://127.0.0.1:5617'
    const server = spawn(
        SERVER_BIN,
        [
            'serve',
            '--bind',
            '127.0.0.1:5617',
            '--password',
            OWNER.password,
            '--rclone-url',
            'http://localhost:5572',
            '--data-dir',
            join(root, 'data'),
        ],
        { stdio: 'ignore' }
    )
    const request = await playwrightRequest.newContext({ baseURL: base })
    try {
        await expect
            .poll(
                async () => (await request.get('/api/session').catch(() => null))?.ok() ?? false,
                {
                    timeout: 30_000,
                    message: 'the server did not come up',
                }
            )
            .toBe(true)
        await signIn(request, base)
        // No page has been opened here, so the document has never been written.
        await stateContract(async (method, data, ifMatch) => {
            const response = await request.fetch('/api/state/app', {
                method,
                headers: { ...SESSION, ...(ifMatch === undefined ? {} : { 'If-Match': ifMatch }) },
                data,
            })
            return { status: response.status(), body: (await response.json()) as StateDoc }
        })
        // Nothing else is a document: not the accounts file beside it, not the name the machine's
        // settings once had.
        for (const name of ['team', 'host', 'hosts/local', '..%2Fstorage']) {
            const response = await request.get(`/api/state/${name}`, { headers: SESSION })
            expect(response.ok(), name).toBe(false)
        }
    } finally {
        await request.dispose()
        server.kill('SIGTERM')
        await new Promise<void>((resolve) => server.once('exit', () => resolve()))
        rmSync(root, { recursive: true, force: true })
    }
})

test('the stand-in the adapter is tested against keeps the same contract', async () => {
    await stateContract(stateStandIn('contract').call)
})

test('two writes from one page to the same document never conflict with each other', async ({
    page,
}) => {
    const errors = collectErrors(page)
    const standIn = stateStandIn('e2e-queue')
    await standIn.serve(page.context())
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    // The adapter behind every store, fed two updates in the same tick, as an effect that sets
    // several keys does. The second must carry the revision the first produced, not race it
    // (a 409 is recovered from, but the browser still logs it as an error).
    const state = await page.evaluate(async (doc) => {
        const storage = window.__RCLONE_CLOUD_API__.state.stateStorage(doc)
        const value = (patch: Record<string, unknown>) =>
            JSON.stringify({ version: 1, state: { a: 1, ...patch } })
        // Hydration reads first, as zustand does; a write before that is dropped (next test).
        await storage.getItem('x')
        await storage.setItem('x', value({}))
        await Promise.all([
            storage.setItem('x', value({ b: 2 })),
            storage.setItem('x', value({ b: 2, c: 3 })),
        ])
        // A write fired without waiting: the barrier resolves once it has landed.
        void storage.setItem('x', value({ b: 2, c: 3, d: 4 }))
        await window.__RCLONE_CLOUD_API__.state.whenWritten(doc)
        return storage.getItem('x')
    }, standIn.name)
    expect(JSON.parse(state as string).state).toEqual({ a: 1, b: 2, c: 3, d: 4 })
    expect(errors, errors.join('\n')).toEqual([])
})

test('a write before the document was read is dropped', async ({ page }) => {
    const errors = collectErrors(page)
    const standIn = stateStandIn('e2e-unread')
    await standIn.serve(page.context())
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    // A store that sets state before its document has loaded holds only defaults; writing them
    // would patch defaults over what other pages saved. The adapter drops that write (with a
    // console warning, not an error) and hydration brings the document's truth.
    const state = await page.evaluate(async (doc) => {
        const storage = window.__RCLONE_CLOUD_API__.state.stateStorage(doc)
        await storage.setItem('x', JSON.stringify({ version: 1, state: { a: 1 } }))
        return storage.getItem('x')
    }, standIn.name)
    expect(state).toBeNull()
    expect(standIn.state()).toEqual({})
    expect(errors, errors.join('\n')).toEqual([])
})

test('two pages creating the same document keep both their keys', async ({ page, context }) => {
    const errors = collectErrors(page)
    const race = stateStandIn('e2e-create-race')
    const later = stateStandIn('e2e-create-later')
    await race.serve(context)
    await later.serve(context)
    const other = await context.newPage()
    const otherErrors = collectErrors(other)
    await page.goto('/')
    await other.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(other.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    // Two pages hydrate an unwritten document at the same time and each write their own key.
    // The second creation is refused (its precondition is revision 0); the loser adopts the
    // winner's document and adds what it lacks, so neither key is lost.
    const doc = race.name
    type Holder = Window & {
        __e2eStorage?: {
            getItem: (name: string) => Promise<unknown>
            setItem: (name: string, value: string) => Promise<void>
        }
    }
    const hydrate = (target: Page) =>
        target.evaluate(async (doc) => {
            const storage = window.__RCLONE_CLOUD_API__.state.stateStorage(doc)
            ;(window as unknown as Holder).__e2eStorage = storage
            await storage.getItem('x')
        }, doc)
    const write = (target: Page, state: Record<string, unknown>) =>
        target.evaluate(async (state) => {
            const storage = (window as unknown as Holder).__e2eStorage
            if (!storage) throw new Error('the page lost its storage')
            await storage.setItem('x', JSON.stringify({ version: 1, state }))
        }, state)
    await hydrate(page)
    await hydrate(other)
    await Promise.all([write(page, { a: 1 }), write(other, { b: 2 })])
    expect(race.state()).toEqual({ a: 1, b: 2 })

    // The same, with the order that loses nothing to chance: the second page hydrated the
    // unwritten document, and by the time it writes the first has created it. It finds that out
    // from its own read instead of a refused creation, and the outcome must be the same. (Left
    // to timing this took the refused-creation path when run alone and this one in a full run,
    // where it removed the first page's key: a page's state was compared with the server's
    // document, so a key it had never heard of read as one it had cleared.)
    const hydrateDoc = (target: Page, name: string) =>
        target.evaluate(async (name) => {
            const storage = window.__RCLONE_CLOUD_API__.state.stateStorage(name)
            ;(window as unknown as Holder).__e2eStorage = storage
            await storage.getItem('x')
        }, name)
    await hydrateDoc(page, later.name)
    await hydrateDoc(other, later.name)
    await write(page, { a: 1 })
    await write(other, { b: 2 })
    expect(later.state()).toEqual({ a: 1, b: 2 })
    // The browser logs the refused creation (a 409) on its own; the page recovered from it.
    // Nothing else may have gone wrong on either page.
    const unexpected = (list: string[]) => list.filter((line) => !line.includes('409'))
    expect(unexpected(errors), errors.join('\n')).toEqual([])
    expect(unexpected(otherErrors), otherErrors.join('\n')).toEqual([])
    await other.close()
})

test('a page writes what it changed, never what it merely holds', async ({ page, context }) => {
    const errors = collectErrors(page)
    const standIn = stateStandIn('e2e-own-changes')
    await standIn.serve(context)
    const other = await context.newPage()
    await page.goto('/')
    await other.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(other.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    // Two pages on one document, each holding all of its keys, as every store does. One changes
    // `x`. The other has not heard yet (the announcement is on its way) and changes `y`, then
    // `z`. Its `x` is the old one, but it never touched it, so it must never write it: a page's
    // changes are what differs from its own last state, not from the server's document.
    const doc = standIn.name
    await standIn.call('PUT', { version: 1, state: { x: 0, y: 0 } })
    type Holder = Window & {
        __e2eStorage?: {
            getItem: (name: string) => Promise<unknown>
            setItem: (name: string, value: string) => Promise<void>
        }
    }
    const hydrate = (target: Page) =>
        target.evaluate(async (doc) => {
            const storage = window.__RCLONE_CLOUD_API__.state.stateStorage(doc)
            ;(window as unknown as Holder).__e2eStorage = storage
            await storage.getItem('x')
        }, doc)
    const write = (target: Page, state: Record<string, unknown>) =>
        target.evaluate(async (state) => {
            const storage = (window as unknown as Holder).__e2eStorage
            if (!storage) throw new Error('the page lost its storage')
            await storage.setItem('x', JSON.stringify({ version: 1, state }))
        }, state)
    const stored = standIn.state
    await hydrate(page)
    await hydrate(other)
    await write(page, { x: 9, y: 0 })
    // Refused once (the revision moved), re-applied on top: both changes stand.
    await write(other, { x: 0, y: 5 })
    expect(stored()).toEqual({ x: 9, y: 5 })
    // Its next change. The `x` it still holds is not one.
    await write(other, { x: 0, y: 5, z: 1 })
    expect(stored()).toEqual({ x: 9, y: 5, z: 1 })
    // Clearing a key is a change: it was in this page's state and is not any more.
    await write(other, { x: 0, y: 5 })
    expect(stored()).toEqual({ x: 9, y: 5 })
    const unexpected = (list: string[]) => list.filter((line) => !line.includes('409'))
    expect(unexpected(errors), errors.join('\n')).toEqual([])
    await other.close()
})

test('a state change by another writer rehydrates an open page', async ({ page, request }) => {
    // The Dashboard's getting-started region is on screen while `onboarding.dismissed` is false.
    const onboarding = page.getByRole('region', { name: 'Getting started' })
    const doc = async () =>
        (await (await request.get('/api/state/app', { headers: SESSION })).json()) as {
            revision: number
            state: { onboarding?: { dismissed: boolean; completed: string[] } }
        }
    const setDismissed = async (dismissed: boolean) => {
        const current = await doc()
        const response = await request.patch('/api/state/app', {
            headers: { ...SESSION, 'If-Match': String(current.revision) },
            data: {
                set: {
                    onboarding: {
                        completed: current.state.onboarding?.completed ?? [],
                        dismissed,
                    },
                },
            },
        })
        expect(response.ok()).toBe(true)
    }
    await setDismissed(false)
    await page.goto('/')
    await expect(onboarding).toBeVisible()

    // Another writer (a second page, the lifecycle) patches the app document: the open page gets
    // `state.changed`, reloads the document and redraws from it.
    await setDismissed(true)
    await expect(onboarding).toHaveCount(0, { timeout: 10_000 })
    await setDismissed(false)
    await expect(onboarding).toBeVisible({ timeout: 10_000 })
})

test('a page that has not heard of another writer leaves that writer’s keys alone, then catches up', async ({
    page,
    request,
}) => {
    type Template = {
        id: string
        name: string
        operation: string
        options: Record<string, unknown>
    }
    type AppDoc = {
        revision: number
        state: { templates?: Template[]; hiddenLocalPaths?: string[] }
    }
    const app = async () =>
        (await (await request.get('/api/state/app', { headers: SESSION })).json()) as AppDoc
    // A writer like any other: refused when the revision has moved, it reads again.
    const renameTemplate = async (name: string) => {
        for (;;) {
            const doc = await app()
            const templates = [
                { id: 'e2e-other-writer', name, operation: 'copy', options: {} },
                ...(doc.state.templates ?? []).filter((one) => one.id !== 'e2e-other-writer'),
            ]
            const response = await request.patch('/api/state/app', {
                headers: { ...SESSION, 'If-Match': String(doc.revision) },
                data: { set: { templates }, unset: [] },
            })
            if (response.status() !== 409) return expect(response.ok()).toBe(true)
        }
    }
    const templateName = async () =>
        (await app()).state.templates?.find((one) => one.id === 'e2e-other-writer')?.name
    // The server's announcements to this page, held back as a slow socket would.
    let holding = false
    const held: (string | Buffer)[] = []
    let toPage: (message: string | Buffer) => void = () => {}
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
        const server = socket.connectToServer()
        socket.onMessage((message) => server.send(message))
        server.onMessage((message) => {
            if (holding) held.push(message)
            else socket.send(message)
        })
        toPage = (message) => socket.send(message)
    })
    // The Commander's shortcuts cog: a switch per local disk, written to `hiddenLocalPaths`.
    const cog = page.getByRole('button', { name: 'Shortcuts' })
    const panel = page.getByRole('dialog', { name: 'Shortcuts' })
    const hidden = async () => (await app()).state.hiddenLocalPaths ?? []
    try {
        await page.goto('/commander')
        await expect(page.getByRole('navigation', { name: 'Places' }).first()).toBeVisible()

        // Another writer adds a template. This page does not hear of it.
        holding = true
        await renameTemplate('Far Template')

        // It changes a key of its own, twice. The first write is refused (the revision moved)
        // and re-applied on top. By the second the adapter knows the newer document while the
        // store still holds the old `templates`: measured against the server's document that would
        // read as this page's change, and be written back over the other writer's.
        await cog.click()
        const first = panel.getByRole('switch').first()
        // HeroUI's switch input is a hidden overlay; a dispatched click toggles it like a real one.
        await first.dispatchEvent('click')
        await expect.poll(async () => (await hidden()).length).toBe(1)
        await first.dispatchEvent('click')
        await expect.poll(async () => (await hidden()).length).toBe(0)
        // The other writer's key is untouched: this page held an older copy of it and wrote
        // only what it changed.
        expect(await templateName()).toBe('Far Template')

        // The announcements arrive, none of them newer than what the adapter has adopted. The
        // store is what is behind, and it catches up all the same — the switch it wrote is still
        // its own, and the other writer's template is still there.
        holding = false
        for (const message of held) toPage(message)
        await expect(first).toBeChecked()
        expect(await templateName()).toBe('Far Template')
    } finally {
        holding = false
        for (;;) {
            const doc = await app()
            const templates = (doc.state.templates ?? []).filter(
                (one) => one.id !== 'e2e-other-writer'
            )
            const response = await request.patch('/api/state/app', {
                headers: { ...SESSION, 'If-Match': String(doc.revision) },
                data: { set: { templates }, unset: [] },
            })
            if (response.status() !== 409) break
        }
    }
})
