import { expect, test } from 'vitest'
import {
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
} from './paths'
import { CASES } from './paths.cases'

// lib/paths.ts is the one grammar for a path string: rclone's own (`fspath.Parse`), stateless,
// the path kept verbatim. The table is read here by the grammar and in `e2e/paths.spec.ts` by
// the real daemon; every expectation is rclone's semantics. The app used to tell remote from
// local by the substring `:/`; that is what the Commander path bar got wrong on `remote:folder`.

test('every path reads the way rclone reads it, and comes back as it went in', () => {
    for (const s of CASES) {
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
    for (const s of CASES) {
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
