import { beforeEach, expect, test, vi } from 'vitest'
import { followSession } from './reconnect'
import { type ConfigStep, cancelSession, nextStep } from './remotes'
import { message, openUrl } from './shell'

vi.mock('./core/api', () => ({ remotes: {} }))
vi.mock('./remotes', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./remotes')>()),
    nextStep: vi.fn(),
    cancelSession: vi.fn(),
    answerSession: vi.fn(),
    startSession: vi.fn(),
}))
vi.mock('./shell', () => ({
    ask: vi.fn(),
    message: vi.fn(),
    openUrl: vi.fn(),
    windowName: () => 'test',
    askOption: vi.fn(),
    clipboard: { setText: vi.fn() },
}))

const step = (state: string, extra: Partial<ConfigStep> = {}): ConfigStep => ({
    id: 'session',
    remote: 'drive',
    kind: 'create',
    state,
    notice: '',
    authUrl: '',
    error: '',
    field: '',
    resultName: '',
    notRewritten: [],
    question: null,
    busy: '',
    ...extra,
})

/** The sign-in dialogs shown so far, each with whether it was closed by the session. */
function dialogs() {
    return vi.mocked(message).mock.calls.map(([text, options]) => ({
        text,
        closed: typeof options === 'object' && !!options.signal?.aborted,
    }))
}

beforeEach(() => {
    vi.mocked(message).mockReset()
    vi.mocked(nextStep).mockReset()
    vi.mocked(cancelSession).mockReset()
    // The dialog stays open until the session closes it, and then answers with Cancel.
    vi.mocked(message).mockImplementation(
        (_text, options) =>
            new Promise((resolve) => {
                const signal = typeof options === 'object' ? options.signal : undefined
                signal?.addEventListener('abort', () => resolve('Cancel sign-in'))
            })
    )
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the sign-in dialog closes itself when the session finishes', async () => {
    const authorize = step('authorize', { authUrl: 'http://127.0.0.1:53682/auth' })
    let finish: (s: ConfigStep) => void = () => undefined
    vi.mocked(nextStep).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    const end = followSession(authorize, 'drive')
    await flush()
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:53682/auth')
    expect(dialogs()).toEqual([{ text: expect.stringContaining('"drive"'), closed: false }])
    finish(step('done', { resultName: 'drive' }))
    await expect(end).resolves.toMatchObject({ state: 'done' })
    await flush()
    expect(dialogs()[0].closed).toBe(true)
    // The closed dialog's answer doesn't cancel the session.
    expect(cancelSession).not.toHaveBeenCalled()
})

test('the sign-in dialog closes itself when the session fails', async () => {
    const authorize = step('authorize', { authUrl: 'http://127.0.0.1:53682/auth' })
    vi.mocked(nextStep).mockResolvedValueOnce(step('failed', { error: 'denied' }))
    await expect(followSession(authorize, 'drive')).resolves.toMatchObject({ state: 'failed' })
    await flush()
    expect(dialogs()).toEqual([{ text: expect.any(String), closed: true }])
    expect(cancelSession).not.toHaveBeenCalled()
})

test('a new sign-in link replaces the dialog, and moving on closes it', async () => {
    vi.mocked(nextStep)
        .mockResolvedValueOnce(step('authorize', { authUrl: 'http://127.0.0.1:53682/second' }))
        .mockResolvedValueOnce(step('working'))
        .mockResolvedValueOnce(step('done'))
    await followSession(step('authorize', { authUrl: 'http://127.0.0.1:53682/first' }), 'drive')
    await flush()
    expect(dialogs().map((d) => d.closed)).toEqual([true, true])
    expect(openUrl).toHaveBeenLastCalledWith('http://127.0.0.1:53682/second')
})

test('cancelling the sign-in ends the session', async () => {
    vi.mocked(message).mockResolvedValueOnce('Cancel sign-in')
    let finish: (s: ConfigStep) => void = () => undefined
    vi.mocked(nextStep).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    const end = followSession(step('authorize', { authUrl: 'http://x/auth' }), 'drive')
    await flush()
    expect(cancelSession).toHaveBeenCalledWith('session')
    finish(step('cancelled'))
    await expect(end).resolves.toMatchObject({ state: 'cancelled' })
})
