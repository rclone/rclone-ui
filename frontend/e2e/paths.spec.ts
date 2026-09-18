import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type APIRequestContext, expect, test } from '@playwright/test'
import {
    type Host,
    POSIX,
    WINDOWS,
    formatRemote,
    fsOf,
    joinRemote,
    parentRemote,
    parsePath,
    pathProblem,
    readablePath,
    remoteParentDir,
} from '../lib/paths'

// lib/paths.ts is the one grammar for a path string: rclone's own (`fspath.Parse`), stateless,
// the path kept verbatim. This is the harness that chose it, kept as its spec: one table of
// paths, each read by the grammar and by the real daemon (`operations/fsinfo` says how it parsed
// an fs string), and every expectation is rclone's semantics. The app used to tell remote from
// local by the substring `:/`; that is what the Commander path bar got wrong on `remote:folder`.

const SESSION = { 'X-RcloneUI-Session': 'e2e', 'Content-Type': 'application/json' }

type Kind = 'remote' | 'local' | 'invalid'
interface Scenario {
    id: string
    input: string
    host?: Host
    kind: Kind
    /** For a remote: the name (with its `:` for an on-the-fly backend) and the verbatim path. */
    name?: string
    path?: string
    /** The fs root and relative path `fsOf` builds. */
    root?: string
    rel?: string
    note?: string
}

const S: Scenario[] = [
    // ---- the four spellings the question is about --------------------------------------------
    {
        id: 'rel',
        input: 'remote:a/path',
        kind: 'remote',
        name: 'remote',
        path: 'a/path',
        root: 'remote:',
        rel: 'a/path',
    },
    {
        id: 'abs',
        input: 'remote:/a/path',
        kind: 'remote',
        name: 'remote',
        path: '/a/path',
        root: 'remote:/',
        rel: 'a/path',
        note: 'the slash is kept: absolute on sftp/local, trimmed by the rest',
    },
    {
        id: 'rel/',
        input: 'remote:a/path/',
        kind: 'remote',
        name: 'remote',
        path: 'a/path/',
        root: 'remote:',
        rel: 'a/path',
    },
    {
        id: 'abs/',
        input: 'remote:/a/path/',
        kind: 'remote',
        name: 'remote',
        path: '/a/path/',
        root: 'remote:/',
        rel: 'a/path',
    },
    {
        id: 'root',
        input: 'remote:',
        kind: 'remote',
        name: 'remote',
        path: '',
        root: 'remote:',
        rel: '',
        note: 'the login directory on sftp; a folder',
    },
    {
        id: 'root/',
        input: 'remote:/',
        kind: 'remote',
        name: 'remote',
        path: '/',
        root: 'remote:/',
        rel: '',
        note: 'the machine root on sftp; a folder',
    },
    {
        id: 'file',
        input: 'remote:a/file.txt',
        kind: 'remote',
        name: 'remote',
        path: 'a/file.txt',
        root: 'remote:',
        rel: 'a/file.txt',
    },
    {
        id: 'colon-in-name',
        input: 'remote:notes/meeting 10:30.txt',
        kind: 'remote',
        name: 'remote',
        path: 'notes/meeting 10:30.txt',
        root: 'remote:',
        rel: 'notes/meeting 10:30.txt',
    },
    {
        id: 'backslash',
        input: 'remote:a\\b',
        kind: 'remote',
        name: 'remote',
        path: 'a\\b',
        root: 'remote:',
        rel: 'a/b',
        note: 'a Windows habit; rclone keeps the path, the fs builder turns it',
    },
    // ---- names rclone allows ------------------------------------------------------------------
    {
        id: 'name-dash',
        input: 'my-drive:x',
        kind: 'remote',
        name: 'my-drive',
        path: 'x',
        root: 'my-drive:',
        rel: 'x',
    },
    {
        id: 'name-space',
        input: 'my drive:x',
        kind: 'remote',
        name: 'my drive',
        path: 'x',
        root: 'my drive:',
        rel: 'x',
    },
    {
        id: 'name-dot+@',
        input: 'r.2+me@home:x',
        kind: 'remote',
        name: 'r.2+me@home',
        path: 'x',
        root: 'r.2+me@home:',
        rel: 'x',
    },
    {
        id: 'name-unicode',
        input: '写真:x',
        kind: 'remote',
        name: '写真',
        path: 'x',
        root: '写真:',
        rel: 'x',
    },
    {
        id: 'looks-local',
        input: 'photos:2024',
        kind: 'remote',
        name: 'photos',
        path: '2024',
        root: 'photos:',
        rel: '2024',
        note: 'rclone: the remote photos; a local folder named so must be spelled /…/photos:2024',
    },
    { id: 'name-bad-start', input: '-bad:x', kind: 'invalid' },
    { id: 'name-bad-char', input: 'a*b:x', kind: 'invalid' },
    { id: 'name-trailing-space', input: 'bad :x', kind: 'invalid' },
    { id: 'empty', input: '', kind: 'invalid' },
    // ---- one letter: the drive question -------------------------------------------------------
    {
        id: 'letter-posix',
        input: 'c:photos',
        host: POSIX,
        kind: 'remote',
        name: 'c',
        path: 'photos',
        root: 'c:',
        rel: 'photos',
        note: 'a remote called c works on macOS/Linux',
    },
    {
        id: 'letter-windows',
        input: 'c:photos',
        host: WINDOWS,
        kind: 'local',
        note: 'rclone on Windows: the C: drive, and the remote c can never be named',
    },
    { id: 'letter-windows-slash', input: 'c:/photos', host: WINDOWS, kind: 'local' },
    {
        id: 'drive-backslash',
        input: 'C:\\Users\\me',
        host: WINDOWS,
        kind: 'local',
        root: ':local:C:/',
        rel: 'Users/me',
    },
    {
        id: 'drive-slash',
        input: 'C:/Users/me',
        host: WINDOWS,
        kind: 'local',
        root: ':local:C:/',
        rel: 'Users/me',
    },
    { id: 'drive-bare', input: 'C:', host: WINDOWS, kind: 'local', root: ':local:C:/', rel: '' },
    {
        id: 'drive-on-posix',
        input: 'C:\\Users\\me',
        host: POSIX,
        kind: 'remote',
        name: 'C',
        path: '\\Users\\me',
        note: 'rclone on macOS/Linux: the remote C (the drive rule is Windows-only); today the app calls it local everywhere',
    },
    { id: 'unc', input: '\\\\srv\\share\\x', host: WINDOWS, kind: 'local' },
    // ---- local ----------------------------------------------------------------------------------
    { id: 'posix', input: '/tmp/photos', kind: 'local', root: ':local:/', rel: 'tmp/photos' },
    { id: 'posix-root', input: '/', kind: 'local', root: ':local:/', rel: '' },
    {
        id: 'posix-colon-in-name',
        input: '/tmp/meeting 10:30.txt',
        kind: 'local',
        root: ':local:/',
        rel: 'tmp/meeting 10:30.txt',
    },
    {
        id: 'relative',
        input: 'x/y',
        kind: 'local',
        note: 'no colon: local, relative to the daemon (as in rclone)',
    },
    { id: 'dot-relative', input: './x', kind: 'local' },
    { id: 'tilde', input: '~/x', kind: 'local' },
    // ---- connection strings: the record, the request builders, on-the-fly backends ----------
    {
        id: 'local-backend',
        input: ':local:/tmp/x',
        kind: 'remote',
        name: ':local',
        path: '/tmp/x',
        root: ':local:/',
        rel: 'tmp/x',
    },
    {
        id: 'local-backend-rel',
        input: ':local:x',
        kind: 'remote',
        name: ':local',
        path: 'x',
        root: ':local:',
        rel: 'x',
        note: "relative to the daemon's working directory: the bare root the app must never send",
    },
    {
        id: 'params',
        input: 'gdrive,chunk_size="64M":albums/',
        kind: 'remote',
        name: 'gdrive',
        path: 'albums/',
        root: 'gdrive,chunk_size="64M":',
        rel: 'albums',
    },
    {
        id: 'params-colon-in-value',
        input: ':sftp,host="a:b",user=me:/srv',
        kind: 'remote',
        name: ':sftp',
        path: '/srv',
        root: ':sftp,host="a:b",user=me:/',
        rel: 'srv',
    },
    {
        id: 'params-flag',
        input: 'gdrive,shared_with_me:',
        kind: 'remote',
        name: 'gdrive',
        path: '',
        root: 'gdrive,shared_with_me:',
        rel: '',
    },
    {
        id: 'params-no-colon',
        input: 'gdrive,chunk_size="64M',
        kind: 'local',
        note: "rclone's first rule: no colon anywhere, so a local path with an odd name",
    },
    { id: 'params-unterminated', input: 'gdrive,chunk_size="64M:', kind: 'invalid' },
    {
        id: 'on-the-fly-slash',
        input: ':sftp/x',
        kind: 'invalid',
        note: 'rclone refuses rather than guesses',
    },
    // ---- not paths ------------------------------------------------------------------------------
    {
        id: 'url',
        input: 'https://example.com/a',
        kind: 'remote',
        name: 'https',
        path: '//example.com/a',
        note: 'to rclone a remote called https; a URL field must not be a path field',
    },
]

test('every path reads the way rclone reads it, and comes back as it went in', () => {
    for (const s of S) {
        const host = s.host ?? POSIX
        const parsed = parsePath(s.input, host)
        expect(parsed.kind, s.id).toBe(s.kind)
        if (parsed.kind === 'remote') {
            expect(parsed.name, s.id).toBe(s.name)
            expect(parsed.path, s.id).toBe(s.path)
            // Nothing added, nothing taken away.
            expect(formatRemote(parsed.name + parsed.params, parsed.path), s.id).toBe(s.input)
        }
        if (s.root !== undefined) {
            const fs = fsOf(s.input, host)
            expect(fs?.root, s.id).toBe(s.root)
            expect(fs?.rel, s.id).toBe(s.rel)
        }
    }
})

test('the fs rclone gets keeps the slash the user typed', () => {
    // The root carries the slash, the rest is relative to it, and a bare root is a folder.
    expect(fsOf('sftp:/var/www/')).toMatchObject({
        root: 'sftp:/',
        rel: 'var/www',
        fs: 'sftp:/var/www/',
        isFolder: true,
    })
    expect(fsOf('sftp:var/www/')).toMatchObject({
        root: 'sftp:',
        rel: 'var/www',
        fs: 'sftp:var/www/',
        isFolder: true,
    })
    expect(fsOf('sftp:')).toMatchObject({ root: 'sftp:', rel: '', fs: 'sftp:', isFolder: true })
    expect(fsOf('sftp:/')).toMatchObject({ root: 'sftp:/', rel: '', fs: 'sftp:/', isFolder: true })
    expect(fsOf('sftp:a/file.txt')).toMatchObject({
        root: 'sftp:',
        rel: 'a/file.txt',
        isFolder: false,
    })
    // Local is the same rule with an explicit root, built here and nowhere else.
    expect(fsOf('/tmp/x/')).toMatchObject({ root: ':local:/', rel: 'tmp/x', fs: ':local:/tmp/x/' })
    expect(fsOf('/')).toMatchObject({ root: ':local:/', rel: '', fs: ':local:/', isFolder: true })
    expect(fsOf('C:\\Users\\me', WINDOWS)).toMatchObject({ root: ':local:C:/', rel: 'Users/me' })
    expect(fsOf('C:', WINDOWS)).toMatchObject({ root: ':local:C:/', rel: '', isFolder: true })
    expect(fsOf(':local:/tmp/x')).toMatchObject({ root: ':local:/', rel: 'tmp/x' })
    expect(fsOf('-bad:x')).toBeUndefined()
})

test('the panel can build and climb both roots without inventing a slash', () => {
    expect(joinRemote('gdrive:', 'photos')).toBe('gdrive:photos')
    expect(joinRemote('gdrive:photos', '2024')).toBe('gdrive:photos/2024')
    expect(joinRemote('gdrive:photos/', '2024')).toBe('gdrive:photos/2024')
    expect(joinRemote('sftp:/', 'var')).toBe('sftp:/var')
    expect(joinRemote('sftp:/var', 'www')).toBe('sftp:/var/www')
    expect(joinRemote(':sftp,host=h:/', 'srv')).toBe(':sftp,host=h:/srv')
    // Up: each root stops at itself; neither turns into the other.
    expect(parentRemote('sftp:/var/www')).toBe('sftp:/var')
    expect(parentRemote('sftp:/var')).toBe('sftp:/')
    expect(parentRemote('sftp:/')).toBe('sftp:/')
    expect(parentRemote('gdrive:photos/2024')).toBe('gdrive:photos')
    expect(parentRemote('gdrive:photos')).toBe('gdrive:')
    expect(parentRemote('gdrive:')).toBe('gdrive:')
    // The same on the panel's own directory string.
    expect(remoteParentDir('/var/www')).toBe('/var')
    expect(remoteParentDir('/var')).toBe('/')
    expect(remoteParentDir('/')).toBe('/')
    expect(remoteParentDir('photos/2024')).toBe('photos')
    expect(remoteParentDir('photos')).toBe('')
    expect(remoteParentDir('')).toBe('')
    // Round trips over every remote row of the table (roots have no leaf; a URL's `//` is no
    // path the panel could produce).
    for (const s of S) {
        if (s.kind !== 'remote' || s.path === '' || s.path === '/' || s.path?.includes('//'))
            continue
        const host = s.host ?? POSIX
        const parsed = parsePath(s.input, host)
        if (parsed.kind !== 'remote') throw new Error(s.id)
        const leaf = parsed.path
            .replace(/[/\\]+$/, '')
            .split(/[/\\]/)
            .pop()!
        expect(joinRemote(parentRemote(s.input, host), leaf, host), s.id).toBe(
            s.input.replace(/[/\\]+$/, '').replace(/\\/g, '/')
        )
    }
})

test('what is shown is what was typed', () => {
    expect(readablePath('gdrive:photos/2024')).toBe('gdrive:photos/2024')
    expect(readablePath('gdrive:/photos/2024')).toBe('gdrive:/photos/2024')
    expect(readablePath('gdrive:')).toBe('gdrive:')
    expect(readablePath('gdrive:/')).toBe('gdrive:/')
    expect(readablePath('gdrive:a/b/c/d/e')).toBe('gdrive:a/.../d/e')
    // Local paths read as they always did.
    expect(readablePath('/Users/me/a/b/c')).toBe('/Users/.../b/c')
    expect(readablePath('/')).toBe('/')
    expect(readablePath('C:\\Users\\me', WINDOWS)).toBe('C:/Users/me')
    expect(readablePath('-bad:x')).toBe('-bad:x')
})

test('what cannot be sent is said, next to the field', () => {
    expect(pathProblem('gdrive:photos')).toBeUndefined()
    expect(pathProblem('/tmp')).toBeUndefined()
    expect(pathProblem('')).toBeUndefined()
    expect(pathProblem('-bad:x')).toBe(
        '‘-bad’ cannot be a remote name. A name may contain letters, digits, spaces and _ - . + @, and cannot start with - or a space.'
    )
    expect(pathProblem('a*b:x')).toMatch(/^‘a\*b’ cannot be a remote name/)
    expect(pathProblem('bad :x')).toMatch(/^‘bad ’ cannot be a remote name/)
    expect(pathProblem('gdrive,chunk_size="64M:')).toBe(
        'The remote’s options are not finished. End them with a colon, as in remote,option=value:path.'
    )
    expect(pathProblem(':sftp/x')).toBe(
        'An on-the-fly remote needs a colon after its type, as in :sftp:path.'
    )
    // A drive path on a host without drives: rclone would take it, and mean something else.
    expect(pathProblem('C:\\Users\\me', POSIX)).toBe(
        'This host is not Windows, so C: would be read as a remote called C. Use a path that starts with /.'
    )
    expect(pathProblem('C:/Users/me', POSIX)).toMatch(/^This host is not Windows/)
    expect(pathProblem('C:\\Users\\me', WINDOWS)).toBeUndefined()
    // A one-letter remote on a host without drives is a remote, and fine.
    expect(pathProblem('c:photos', POSIX)).toBeUndefined()
})

// ---- the real rclone ------------------------------------------------------------------------------

/** How the daemon read an fs string: its backend name and root, or the error it gave. */
async function rcloneReads(request: APIRequestContext, fs: string) {
    const response = await request.post('/api/rc/local/operations/fsinfo', {
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
    for (const s of S) {
        if (s.host === WINDOWS) continue
        const read = await rcloneReads(request, s.input)
        // A parse error is one thing; a remote that parsed and then failed to exist or to
        // connect (an unknown section, an sftp host called a:b) is a remote all the same.
        const parseError =
            /invalid characters|config name|config parameter|quoted config value|syntax error|empty string/
        const verdict: Kind =
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
        // segment. So the slash the user meant has to be in the fs string, which is what S1's
        // `root` carries.
        const inside = await request.post('/api/rc/local/operations/stat', {
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
