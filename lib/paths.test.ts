import { expect, test, vi } from 'vitest'
import table from '../testdata/paths_cases.json'
import {
    baseName,
    configNameOf,
    formatRemote,
    type Host,
    joinLocalDir,
    joinLocalSegments,
    joinRemoteDir,
    localParentDir,
    localRoot,
    localRootOf,
    localSegments,
    POSIX,
    parsePath,
    pathProblem,
    pickerStart,
    readablePath,
    remoteParentDir,
    toWrappedRemote,
    WINDOWS,
} from './paths'

// The machine that paths are built for, as the shell reports it. The tests switch it to read
// paths as Windows would.
const machine = vi.hoisted(() => ({ windows: false }))
vi.mock('./shell', () => ({ isWindows: () => machine.windows }))

// The table (`testdata/paths_cases.json`) is read here and also by a Go test that checks it
// against rclone's `fspath`, so every expectation matches rclone's behavior.

interface PathCase {
    id: string
    input: string
    host?: Host
    kind: 'remote' | 'local' | 'invalid'
    /** For a remote: the name (with its `:` for an on-the-fly backend) and the path as typed. */
    name?: string
    path?: string
    /** The fs root and relative path that the core splits it into (`Split` in `core/location`). */
    root?: string
    rel?: string
    /** The message that `pathProblem` returns for it, if any. */
    problem?: string
}

const CASES = table as PathCase[]

const TRAILING_SEPARATORS = /[/\\]+$/
const TRAILING_SLASHES = /\/+$/
const BACKSLASHES = /\\/g

function expectCase(s: PathCase, host: Host | undefined) {
    const parsed = parsePath(s.input, host)
    expect(parsed.kind, s.id).toBe(s.kind)
    if (parsed.kind === 'remote') {
        expect(parsed.name, s.id).toBe(s.name)
        expect(parsed.path, s.id).toBe(s.path)
        // Nothing is added and nothing is removed.
        expect(formatRemote(parsed.name + parsed.params, parsed.path), s.id).toBe(s.input)
    }
    expect(pathProblem(s.input, host), s.id).toBe(s.problem)
}

test('every path reads the way rclone reads it, and comes back as it went in', () => {
    expect(CASES.length).toBeGreaterThan(0)
    for (const s of CASES) expectCase(s, s.host ?? POSIX)
})

test('without a host given, the grammar reads the machine’s from the shell', () => {
    try {
        for (const s of CASES) {
            machine.windows = s.host?.windows ?? false
            expectCase(s, undefined)
        }
    } finally {
        machine.windows = false
    }
})

test('the panel can build and climb both roots without inventing a slash', () => {
    // The directory string that the panel keeps is the part after the colon.
    expect(joinRemoteDir('', 'photos')).toBe('photos')
    expect(joinRemoteDir('photos', '2024')).toBe('photos/2024')
    expect(joinRemoteDir('photos/', '2024')).toBe('photos/2024')
    expect(joinRemoteDir('/', 'var')).toBe('/var')
    expect(joinRemoteDir('/var', 'www')).toBe('/var/www')
    // Going up stops at each root, and neither root turns into the other.
    expect(remoteParentDir('/var/www')).toBe('/var')
    expect(remoteParentDir('/var')).toBe('/')
    expect(remoteParentDir('/')).toBe('/')
    expect(remoteParentDir('photos/2024')).toBe('photos')
    expect(remoteParentDir('photos')).toBe('')
    expect(remoteParentDir('')).toBe('')
    // Round trips over every remote row of the table. Roots are skipped because they have no
    // leaf, and so are URLs with `//`, because the panel can't produce such a path. A backslash
    // is a separator on a Windows host only.
    for (const s of CASES) {
        if (s.kind !== 'remote' || s.path === '' || s.path === '/' || s.path?.includes('//'))
            continue
        const host = s.host ?? POSIX
        const parsed = parsePath(s.input, host)
        if (parsed.kind !== 'remote') throw new Error(s.id)
        const leaf = baseName(s.input, host)
        const whole = host.windows
            ? s.input.replace(TRAILING_SEPARATORS, '').replace(BACKSLASHES, '/')
            : s.input.replace(TRAILING_SLASHES, '')
        const up = remoteParentDir(parsed.path, host)
        expect(`${parsed.name}${parsed.params}:${joinRemoteDir(up, leaf, host)}`, s.id).toBe(whole)
    }
})

test('a backslash separates on a Windows host only, as rclone reads it', () => {
    // Elsewhere it is part of a name, so `a\b` is one folder and its parent is the root.
    expect(joinRemoteDir('a\\b', 'c', POSIX)).toBe('a\\b/c')
    expect(joinRemoteDir('a\\b', 'c', WINDOWS)).toBe('a/b/c')
    expect(joinRemoteDir('\\a', 'b', POSIX)).toBe('\\a/b')
    expect(joinRemoteDir('\\a', 'b', WINDOWS)).toBe('/a/b')
    expect(remoteParentDir('a\\b', POSIX)).toBe('')
    expect(remoteParentDir('a\\b', WINDOWS)).toBe('a')
    expect(remoteParentDir('/x\\y', POSIX)).toBe('/')
    expect(remoteParentDir('\\x\\y', WINDOWS)).toBe('/x')
    expect(remoteParentDir('/srv/a\\b', POSIX)).toBe('/srv')
    expect(remoteParentDir('/srv/a\\b', WINDOWS)).toBe('/srv/a')
    expect(readablePath('gdrive:a\\b\\c\\d\\e', POSIX)).toBe('gdrive:a\\b\\c\\d\\e')
    expect(readablePath('gdrive:a\\b\\c\\d\\e', WINDOWS)).toBe('gdrive:a/.../d/e')
    expect(readablePath('/tmp/a\\b.txt', POSIX)).toBe('/tmp/a\\b.txt')
    expect(readablePath('C:\\a\\b\\c\\d', WINDOWS)).toBe('C:/a/.../c/d')
})

test('the name at the end of a path', () => {
    expect(baseName('gdrive:notes/meeting 10:30.txt')).toBe('meeting 10:30.txt')
    expect(baseName('gdrive:photos/')).toBe('photos')
    expect(baseName('sftp:/var')).toBe('var')
    expect(baseName('/Users/me/a.txt')).toBe('a.txt')
    expect(baseName(':local:/tmp/x')).toBe('x')
    expect(baseName('/tmp/a\\b.txt', POSIX)).toBe('a\\b.txt')
    expect(baseName('C:\\Users\\me\\a.txt', WINDOWS)).toBe('a.txt')
    // A root has no name at the end.
    expect(baseName('gdrive:')).toBe('')
    expect(baseName('sftp:/')).toBe('')
    expect(baseName('/')).toBe('')
    expect(baseName('C:\\', WINDOWS)).toBe('')
    expect(baseName('C:', WINDOWS)).toBe('')
})

test('what is shown is what was typed', () => {
    expect(readablePath('gdrive:photos/2024')).toBe('gdrive:photos/2024')
    expect(readablePath('gdrive:/photos/2024')).toBe('gdrive:/photos/2024')
    expect(readablePath('gdrive:')).toBe('gdrive:')
    expect(readablePath('gdrive:/')).toBe('gdrive:/')
    expect(readablePath('gdrive:a/b/c/d/e')).toBe('gdrive:a/.../d/e')
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
    // A drive path on a host without drives: rclone would accept it, but read it differently.
    expect(pathProblem('C:\\Users\\me', POSIX)).toBe(
        'This host is not Windows, so C: would be read as a remote called C. Use a path that starts with /.'
    )
    expect(pathProblem('C:/Users/me', POSIX)).toMatch(/^This host is not Windows/)
    expect(pathProblem('C:\\Users\\me', WINDOWS)).toBeUndefined()
    // A drive with no separator after it means the drive's current folder, which depends on
    // the core's working directory.
    const notFull = 'This is not a full path. Use one that starts with a drive, as in C:\\.'
    expect(pathProblem('C:', WINDOWS)).toBe(notFull)
    expect(pathProblem('C:foo', WINDOWS)).toBe(notFull)
    expect(pathProblem(':local:C:foo', WINDOWS)).toBe(notFull)
    expect(pathProblem('C:\\', WINDOWS)).toBeUndefined()
    expect(pathProblem('c:/foo', WINDOWS)).toBeUndefined()
    expect(pathProblem('\\\\nas\\share\\x', WINDOWS)).toBeUndefined()
    // On a host without drives, a one-letter remote is a valid remote.
    expect(pathProblem('c:photos', POSIX)).toBeUndefined()
})

test('a local path climbs to its root and stops there', () => {
    const parents: [string, string, Host][] = [
        ['/a/b', '/a', POSIX],
        ['/a/b/', '/a', POSIX],
        ['/a', '/', POSIX],
        ['/', '/', POSIX],
        ['a/b', 'a', POSIX],
        ['a', '', POSIX],
        // On other hosts a backslash is part of a name.
        ['/tmp/a\\b', '/tmp', POSIX],
        ['C:\\a\\b', 'C:\\a', WINDOWS],
        ['C:\\a', 'C:\\', WINDOWS],
        ['C:/a', 'C:\\', WINDOWS],
        ['C:\\', 'C:\\', WINDOWS],
        ['C:', 'C:', WINDOWS],
        ['\\\\nas\\share\\a\\b', '\\\\nas\\share\\a', WINDOWS],
        ['\\\\nas\\share\\a', '\\\\nas\\share\\', WINDOWS],
        ['\\\\nas\\share\\', '\\\\nas\\share\\', WINDOWS],
        ['\\\\nas\\share', '\\\\nas\\share', WINDOWS],
        ['a', '', WINDOWS],
    ]
    for (const [path, parent, host] of parents) {
        expect(localParentDir(path, host), path).toBe(parent)
    }
    expect(localRoot('/a/b', POSIX)).toBe('/')
    expect(localRoot('a/b', POSIX)).toBe('')
    expect(localRoot('c:/a', WINDOWS)).toBe('c:\\')
    expect(localRoot('//nas/share/a', WINDOWS)).toBe('\\\\nas\\share\\')
})

test('a name joins a local folder with the host separator, a share keeping its two', () => {
    expect(joinLocalDir('/tmp', 'x', POSIX)).toBe('/tmp/x')
    expect(joinLocalDir('/tmp/', 'x', POSIX)).toBe('/tmp/x')
    expect(joinLocalDir('/', 'x', POSIX)).toBe('/x')
    expect(joinLocalDir('C:\\', 'x', WINDOWS)).toBe('C:\\x')
    expect(joinLocalDir('C:', 'x', WINDOWS)).toBe('C:\\x')
    expect(joinLocalDir('C:\\Users', 'x', WINDOWS)).toBe('C:\\Users\\x')
    expect(joinLocalDir('\\\\nas\\share', 'docs', WINDOWS)).toBe('\\\\nas\\share\\docs')
    expect(joinLocalDir('\\\\nas\\share\\docs\\', 'x', WINDOWS)).toBe('\\\\nas\\share\\docs\\x')
})

test('breadcrumb segments rebuild a local path with the host separator', () => {
    // The path bar splits `C:\\Users\\me` into C:, Users and me. A click has to put the drive
    // back in front, not a slash, because `/C:/Users` lists nothing on Windows. A share is one
    // segment.
    expect(localSegments('/tmp/x', POSIX)).toEqual(['tmp', 'x'])
    expect(localSegments('/', POSIX)).toEqual([])
    expect(localSegments('C:\\Users\\me', WINDOWS)).toEqual(['C:', 'Users', 'me'])
    expect(localSegments('\\\\nas\\share\\docs', WINDOWS)).toEqual(['\\\\nas\\share', 'docs'])
    expect(localSegments('\\\\nas\\share', WINDOWS)).toEqual(['\\\\nas\\share'])
    expect(joinLocalSegments(['C:'], WINDOWS)).toBe('C:\\')
    expect(joinLocalSegments(['C:', 'Users', 'me'], WINDOWS)).toBe('C:\\Users\\me')
    expect(joinLocalSegments(['\\\\nas\\share'], WINDOWS)).toBe('\\\\nas\\share\\')
    expect(joinLocalSegments(['\\\\nas\\share', 'docs'], WINDOWS)).toBe('\\\\nas\\share\\docs')
    expect(joinLocalSegments(['tmp', 'x'], POSIX)).toBe('/tmp/x')
    expect(joinLocalSegments([], POSIX)).toBe('/')
    // The Local button goes to the drive's or share's root on Windows, and to `/` elsewhere.
    expect(localRootOf(['C:', 'Users', 'me'], WINDOWS)).toBe('C:\\')
    expect(localRootOf(['\\\\nas\\share', 'docs'], WINDOWS)).toBe('\\\\nas\\share\\')
    expect(localRootOf(['tmp', 'x'], POSIX)).toBe('/')
})

test('a remote with parameters is its config by the name before them', () => {
    expect(configNameOf('gdrive')).toBe('gdrive')
    expect(configNameOf('gdrive,shared_with_me')).toBe('gdrive')
    expect(configNameOf(':sftp,host=h')).toBe(':sftp')
})

test('a picked folder becomes a wrapping remote’s remote option', () => {
    const posix: [string, string][] = [
        ['gdrive:', 'gdrive:'],
        ['gdrive:photos/', 'gdrive:photos'],
        ['gdrive:photos/2024', 'gdrive:photos/2024'],
        ['sftp:/', 'sftp:/'],
        ['sftp://', 'sftp:/'],
        ['sftp:/srv/', 'sftp:/srv'],
        ['gdrive,shared_with_me:docs/', 'gdrive,shared_with_me:docs'],
        ['/Users/me/Pictures/', '/Users/me/Pictures'],
        ['/', '/'],
        ['/tmp/a\\', '/tmp/a\\'],
    ]
    for (const [picked, want] of posix) expect(toWrappedRemote(picked, POSIX)).toBe(want)
    const windows: [string, string][] = [
        ['C:\\', 'C:\\'],
        ['C:\\Users\\me\\', 'C:\\Users\\me'],
        ['\\\\nas\\share\\docs\\', '\\\\nas\\share\\docs'],
        ['gdrive:photos\\', 'gdrive:photos'],
    ]
    for (const [picked, want] of windows) expect(toWrappedRemote(picked, WINDOWS)).toBe(want)
})

test('a file picker opens at the folder of the current value', () => {
    expect(pickerStart(undefined, false, POSIX)).toBeUndefined()
    expect(pickerStart('  ', true, POSIX)).toBeUndefined()
    expect(pickerStart('/etc/ssh/key.pem', false, POSIX)).toBe('/etc/ssh')
    expect(pickerStart('/key.pem', false, POSIX)).toBe('/')
    expect(pickerStart('/var/cache/rclone', true, POSIX)).toBe('/var/cache/rclone')
    expect(pickerStart('C:\\keys\\sa.json', false, WINDOWS)).toBe('C:\\keys')
    expect(pickerStart('C:\\sa.json', false, WINDOWS)).toBe('C:\\')
    expect(pickerStart('key.pem', false, POSIX)).toBeUndefined()
})
