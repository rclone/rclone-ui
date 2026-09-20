import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type APIRequestContext, expect, test } from '@playwright/test'
import { WINDOWS } from '../lib/paths'
import { CASES, type PathKind } from '../lib/paths.cases'
import { SESSION } from './helpers'

// The grammar's table (`lib/paths.cases.ts`, read by `lib/paths.test.ts`) against the real
// daemon: `operations/fsinfo` says how rclone parsed an fs string, and every row must agree.

/** How the daemon read an fs string: its backend name and root, or the error it gave. */
async function rcloneReads(request: APIRequestContext, fs: string) {
    const response = await request.post('/api/rc/operations/fsinfo', {
        headers: SESSION,
        data: { fs },
    })
    const body = (await response.json()) as { Name?: string; Root?: string; error?: string }
    return body.error ? { error: body.error } : { name: body.Name, root: body.Root }
}

test('rclone itself reads every row the same way', async ({ request }) => {
    // A remote the daemon has (e2e-memory), one it has not (everything else), and the local
    // backend: what fsinfo answers says how the string was parsed. The daemon runs on the machine
    // running this suite, which is not Windows: the Windows rows are the source's word.
    for (const s of CASES) {
        if (s.host === WINDOWS) continue
        const read = await rcloneReads(request, s.input)
        // A parse error is one thing; a remote that parsed and then failed to exist or to
        // connect (an unknown section, an sftp host called a:b) is a remote all the same.
        const parseError =
            /invalid characters|config name|config parameter|quoted config value|syntax error|empty string/
        const verdict: PathKind =
            'error' in read
                ? parseError.test(read.error)
                    ? 'invalid'
                    : 'remote'
                : read.name === 'local'
                  ? 'local'
                  : 'remote'
        expect(verdict, `${s.id}: ${JSON.stringify(read)}`).toBe(s.kind)
    }
})

test('the slash after the colon: kept by the local backend, trimmed by memory', async ({
    request,
}) => {
    // The one backend at hand where a leading slash means something is the local one, which
    // is also the one the app spells `:local:`. The memory remote stands for the many that trim.
    const dir = mkdtempSync(join(tmpdir(), 'rcui-slash-'))
    try {
        mkdirSync(join(dir, 'a', 'b'), { recursive: true })
        writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x')
        const abs = await rcloneReads(request, `:local:${dir}/a`)
        const rel = await rcloneReads(request, `:local:${dir.slice(1)}/a`)
        expect(abs).toMatchObject({ root: `${dir}/a` })
        // Without the slash rclone resolves against the daemon's working directory: another
        // place entirely (whatever that directory is, it is not the temp dir).
        expect('root' in rel && rel.root).not.toBe(`${dir}/a`)

        // A slash inside `remote` does not escape the fs root: Go's path.Join treats it as a
        // segment. So the slash the user meant has to be in the fs string, which is what the
        // table's `root` carries.
        const inside = await request.post('/api/rc/operations/stat', {
            headers: SESSION,
            data: { fs: `:local:${dir}/a`, remote: '/b/f.txt' },
        })
        const stat = (await inside.json()) as { item: { Name: string; Size: number } | null }
        expect(stat.item).toMatchObject({ Name: 'f.txt', Size: 1 })

        // memory: the two spellings are one place.
        const withSlash = await rcloneReads(request, 'e2e-memory:/harness')
        const without = await rcloneReads(request, 'e2e-memory:harness')
        expect(withSlash).toEqual(without)
        expect(withSlash).toMatchObject({ name: 'e2e-memory', root: 'harness' })
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
