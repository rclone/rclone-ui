import {
    FileArchiveIcon,
    FileAudioIcon,
    FileCodeIcon,
    FileIcon as FileIconLucide,
    FileImageIcon,
    FileJson2Icon,
    FileSpreadsheetIcon,
    FileTextIcon,
    FileTypeIcon,
    FileVideoIcon,
    FolderIcon,
} from 'lucide-react'
import type { Entry } from './types'
import { getFileExtension } from './utils'

const IMAGE_EXTENSIONS = new Set([
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'svg',
    'bmp',
    'ico',
    'tiff',
    'tif',
    'heic',
    'heif',
    'avif',
])

const VIDEO_EXTENSIONS = new Set([
    'mp4',
    'webm',
    'mkv',
    'avi',
    'mov',
    'wmv',
    'flv',
    'm4v',
    'mpg',
    'mpeg',
    '3gp',
    'ogv',
])

const AUDIO_EXTENSIONS = new Set([
    'mp3',
    'wav',
    'ogg',
    'flac',
    'aac',
    'm4a',
    'wma',
    'opus',
    'aiff',
    'mid',
    'midi',
])

const ARCHIVE_EXTENSIONS = new Set([
    'zip',
    'rar',
    '7z',
    'tar',
    'gz',
    'bz2',
    'xz',
    'tgz',
    'tbz2',
    'lz',
    'lzma',
    'cab',
    'iso',
    'dmg',
])

const CODE_EXTENSIONS = new Set([
    'js',
    'ts',
    'jsx',
    'tsx',
    'py',
    'rb',
    'java',
    'c',
    'cpp',
    'h',
    'hpp',
    'cs',
    'go',
    'rs',
    'php',
    'swift',
    'kt',
    'scala',
    'sh',
    'bash',
    'zsh',
    'ps1',
    'bat',
    'cmd',
    'lua',
    'r',
    'pl',
    'pm',
    'ex',
    'exs',
    'erl',
    'hrl',
    'clj',
    'cljs',
    'hs',
    'ml',
    'fs',
    'vb',
    'asm',
    's',
    // Markup / web / query / misc — all highlighted by the CodeMirror langs pack.
    'html',
    'htm',
    'xml',
    'css',
    'scss',
    'sass',
    'less',
    'sql',
    'vue',
    'svelte',
    'dart',
    'gradle',
    'groovy',
    'proto',
    'diff',
    'patch',
])

const CONFIG_EXTENSIONS = new Set([
    'json',
    'yaml',
    'yml',
    'toml',
    'ini',
    'cfg',
    'conf',
    'config',
    'env',
    'properties',
])

const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'pages'])

const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'csv', 'ods', 'numbers'])

const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx', 'odp', 'key'])

const TEXT_EXTENSIONS = new Set([
    'txt',
    'md',
    'markdown',
    'rst',
    'log',
    'readme',
    'license',
    'changelog',
    'todo',
])

export type FileType =
    | 'folder'
    | 'image'
    | 'video'
    | 'audio'
    | 'archive'
    | 'code'
    | 'config'
    | 'document'
    | 'spreadsheet'
    | 'presentation'
    | 'text'
    | 'unknown'

export function getFileType(entry: Entry): FileType {
    if (entry.isDir) return 'folder'

    const ext = getFileExtension(entry.name)

    if (IMAGE_EXTENSIONS.has(ext)) return 'image'
    if (VIDEO_EXTENSIONS.has(ext)) return 'video'
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
    if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive'
    if (CODE_EXTENSIONS.has(ext)) return 'code'
    if (CONFIG_EXTENSIONS.has(ext)) return 'config'
    if (DOCUMENT_EXTENSIONS.has(ext)) return 'document'
    if (SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet'
    if (PRESENTATION_EXTENSIONS.has(ext)) return 'presentation'
    if (TEXT_EXTENSIONS.has(ext)) return 'text'

    return 'unknown'
}

export function isPreviewable(entry: Entry): boolean {
    const type = getFileType(entry)
    return (
        type === 'image' ||
        type === 'video' ||
        type === 'audio' ||
        type === 'text' ||
        type === 'code' ||
        type === 'config' ||
        type === 'document' ||
        type === 'spreadsheet' ||
        type === 'presentation'
    )
}

const ICON_SIZE_MAP = {
    sm: 'size-4',
    md: 'size-5',
    lg: 'size-6',
} as const

export default function FileIcon({
    entry,
    size = 'md',
}: {
    entry: Entry
    size?: 'sm' | 'md' | 'lg'
}) {
    const sizeClass = ICON_SIZE_MAP[size]
    const type = getFileType(entry)

    switch (type) {
        case 'folder':
            return <FolderIcon className={`${sizeClass} text-warning shrink-0`} />
        case 'image':
            return <FileImageIcon className={`${sizeClass} text-success shrink-0`} />
        case 'video':
            return <FileVideoIcon className={`${sizeClass} text-danger shrink-0`} />
        case 'audio':
            return <FileAudioIcon className={`${sizeClass} text-secondary shrink-0`} />
        case 'archive':
            return <FileArchiveIcon className={`${sizeClass} text-warning shrink-0`} />
        case 'code':
            return <FileCodeIcon className={`${sizeClass} text-primary shrink-0`} />
        case 'config':
            return <FileJson2Icon className={`${sizeClass} text-default-500 shrink-0`} />
        case 'document':
            return <FileTypeIcon className={`${sizeClass} text-danger shrink-0`} />
        case 'spreadsheet':
            return <FileSpreadsheetIcon className={`${sizeClass} text-success shrink-0`} />
        case 'presentation':
            return <FileTypeIcon className={`${sizeClass} text-warning shrink-0`} />
        case 'text':
            return <FileTextIcon className={`${sizeClass} text-default-600 shrink-0`} />
        default:
            return <FileIconLucide className={`${sizeClass} text-default-400 shrink-0`} />
    }
}
