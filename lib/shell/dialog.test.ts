import { afterEach, describe, expect, it } from 'vitest'
import { Kind, Option } from './bindings/github.com/rclone/rclone-ui/core/catalog/models'
import { type DialogRequest, settle, subscribe } from './dialog'
import { ask, askOption, message, prompt } from './index'

// The pages' dialogs are a queue that DialogHost shows. These tests stand in for the host: they
// read the queue and answer its head.
let queue: DialogRequest[] = []
subscribe((q) => {
    queue = q
})

/** Answers the dialog at the head of the queue, as the host does. */
function answer(value: string | null) {
    const head = queue[0]
    if (!head) throw new Error('no dialog')
    if (head.type === 'message') head.resolve(value ?? '')
    else head.resolve(value)
    settle(head)
}

afterEach(() => {
    for (const r of [...queue]) settle(r)
})

describe('dialogs', () => {
    it('shows one at a time, in order', async () => {
        const first = message('one')
        const second = ask('two?', { title: 'Two', okLabel: 'Delete', cancelLabel: 'Keep it' })
        expect(queue.map((r) => r.message)).toEqual(['one', 'two?'])
        expect(queue[0]).toMatchObject({
            title: 'Rclone UI',
            kind: 'info',
            buttons: { ok: 'OK' },
        })
        expect(queue[1]).toMatchObject({
            title: 'Two',
            buttons: { ok: 'Delete', cancel: 'Keep it' },
        })
        answer('OK')
        expect(await first).toBe('OK')
        expect(queue).toHaveLength(1)
        answer('Keep it')
        expect(await second).toBe(false)
        expect(queue).toHaveLength(0)
    })

    it('keeps the OK and Cancel defaults, and up to three buttons', async () => {
        const question = ask('Sure?')
        expect(queue[0]).toMatchObject({ buttons: { ok: 'OK', cancel: 'Cancel' } })
        answer('OK')
        expect(await question).toBe(true)

        const three = message('Retry?', {
            title: 'Failed',
            kind: 'error',
            buttons: { ok: 'Retry', cancel: 'Close', extra: 'Show transfer' },
        })
        expect(queue[0]).toMatchObject({
            kind: 'error',
            buttons: { ok: 'Retry', cancel: 'Close', extra: 'Show transfer' },
        })
        answer('Show transfer')
        expect(await three).toBe('Show transfer')
    })

    it('asks for text, hidden for a password', async () => {
        const name = prompt({ title: 'Password', message: 'Type it', sensitive: true })
        expect(queue[0]).toMatchObject({ type: 'prompt', sensitive: true, defaultValue: '' })
        answer('secret')
        expect(await name).toBe('secret')
        const cancelled = prompt({ title: 'New Folder', message: '', default: 'untitled' })
        expect(queue[0]).toMatchObject({ defaultValue: 'untitled', sensitive: false })
        answer(null)
        expect(await cancelled).toBeNull()
    })

    it('closes when its signal aborts', async () => {
        const controller = new AbortController()
        const question = ask('Replace?', { signal: controller.signal })
        const after = message('next')
        controller.abort()
        expect(await question).toBe(false)
        expect(queue.map((r) => r.message)).toEqual(['next'])
        answer('OK')
        await after

        const closed = message('x', { buttons: { cancel: 'Close' }, signal: controller.signal })
        expect(await closed).toBe('Close')
        expect(queue).toHaveLength(0)
        expect(await prompt({ title: 't', message: 'm', signal: AbortSignal.abort() })).toBeNull()
    })

    it('asks a config question with its option, and its notice', async () => {
        const option = new Option({
            name: 'scope',
            help: 'Scope that rclone uses.',
            kind: Kind.KindText,
        })
        const scope = askOption(option, 'That scope is unknown.')
        expect(queue[0]).toMatchObject({
            type: 'option',
            title: 'Configure remote',
            message: 'Scope that rclone uses.',
            notice: 'That scope is unknown.',
            option,
        })
        answer('drive.file')
        expect(await scope).toBe('drive.file')

        const cancelled = askOption(new Option({ name: 'token' }))
        expect(queue[0]).toMatchObject({ message: 'token', notice: '' })
        answer(null)
        expect(await cancelled).toBeNull()

        const controller = new AbortController()
        const aborted = askOption(option, undefined, controller.signal)
        controller.abort()
        expect(await aborted).toBeNull()
        expect(queue).toHaveLength(0)
    })
})
