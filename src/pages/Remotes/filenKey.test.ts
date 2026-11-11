import { beforeEach, expect, test, vi } from 'vitest'
import { coreFailure } from '../../../lib/errors.testing'
import { filenApiKey } from '../../../lib/remotes'
import { prompt } from '../../../lib/shell'
import { generateFilenApiKey } from './filenKey'

vi.mock('../../../lib/remotes', () => ({ filenApiKey: vi.fn() }))
vi.mock('../../../lib/shell', () => ({ prompt: vi.fn() }))

const askCode = coreFailure('invalid', 'refused', {
    fields: [{ field: 'code', description: 'Enter the code from your authenticator app.' }],
})

beforeEach(() => {
    vi.mocked(filenApiKey).mockReset()
    vi.mocked(prompt).mockReset()
})

function twoFactorAccount() {
    vi.mocked(filenApiKey).mockImplementation(async (_email, _password, code) => {
        if (code !== '123456') throw askCode
        return 'the-key'
    })
}

test('the two-factor code is asked for and trimmed', async () => {
    twoFactorAccount()
    vi.mocked(prompt).mockResolvedValueOnce('  123456 \n')
    await expect(generateFilenApiKey({ email: 'me@x', password: 'pw' })).resolves.toBe('the-key')
    expect(vi.mocked(filenApiKey).mock.calls.map((c) => c[2])).toEqual(['', '123456'])
})

test('cancelling the two-factor prompt stops quietly', async () => {
    twoFactorAccount()
    vi.mocked(prompt).mockResolvedValueOnce(null)
    await expect(generateFilenApiKey({ email: 'me@x', password: 'pw' })).resolves.toBeNull()
    vi.mocked(prompt).mockResolvedValueOnce('   ')
    await expect(generateFilenApiKey({ email: 'me@x', password: 'pw' })).resolves.toBeNull()
    expect(filenApiKey).toHaveBeenCalledTimes(2)
})

test('other errors reach the field', async () => {
    vi.mocked(filenApiKey).mockRejectedValue(
        coreFailure('invalid', 'Filen did not answer in time.')
    )
    await expect(generateFilenApiKey({ email: 'me@x', password: 'pw' })).rejects.toThrow(
        'Filen did not answer in time.'
    )
    expect(prompt).not.toHaveBeenCalled()
})
