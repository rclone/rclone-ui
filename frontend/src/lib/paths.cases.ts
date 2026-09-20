import { type Host, POSIX, WINDOWS } from './paths'

// The table `paths.test.ts` reads through the grammar and `e2e/paths.spec.ts` reads through the
// real daemon: one set of paths, and every expectation is rclone's semantics. Test data only;
// nothing in the app imports it.

export type PathKind = 'remote' | 'local' | 'invalid'

export interface PathCase {
    id: string
    input: string
    host?: Host
    kind: PathKind
    /** For a remote: the name (with its `:` for an on-the-fly backend) and the verbatim path. */
    name?: string
    path?: string
    /** The fs root and relative path `fsOf` builds. */
    root?: string
    rel?: string
    note?: string
}

export const CASES: PathCase[] = [
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
