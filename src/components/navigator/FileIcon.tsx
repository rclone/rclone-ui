import { t } from '@lingui/core/macro'
import {
    BrowserCodeSimple as BrowserCodeSimpleIcon,
    ChartColumn as ChartColumnIcon,
    Code as CodeIcon,
    FileText as FileTextIcon,
    FileZip as FileZipIcon,
    Film as FilmIcon,
    Folder as FolderIcon,
    Image as ImageIcon,
    Memo as MemoIcon,
    Music as MusicIcon,
    File as PlainFileIcon,
    PresentationScreen as PresentationScreenIcon,
} from '@zappicon/react'
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

export function fileTypeName(type: FileType): string {
    switch (type) {
        case 'folder':
            return t({ message: 'Folder', context: 'file type' })
        case 'image':
            return t({ message: 'Image', context: 'file type' })
        case 'video':
            return t({ message: 'Video', context: 'file type' })
        case 'audio':
            return t({ message: 'Audio', context: 'file type' })
        case 'archive':
            return t({
                message: 'Archive',
                context: 'file type',
                comment: 'A zip or similar file.',
            })
        case 'code':
            return t({ message: 'Code', context: 'file type', comment: 'A source code file.' })
        case 'config':
            return t({
                message: 'Config',
                context: 'file type',
                comment: 'A configuration file, such as .json or .yaml.',
            })
        case 'document':
            return t({ message: 'Document', context: 'file type' })
        case 'spreadsheet':
            return t({ message: 'Spreadsheet', context: 'file type' })
        case 'presentation':
            return t({ message: 'Presentation', context: 'file type' })
        case 'text':
            return t({ message: 'Text', context: 'file type' })
        default:
            return t({
                message: 'Unknown',
                context: 'file type',
                comment: 'A file whose type the app does not know.',
            })
    }
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

// Folders are filled, as in the system's file browser. Files are drawn in two tones of their
// kind's color, so the kinds tell apart at a glance.
const KIND: Record<
    Exclude<FileType, 'folder'>,
    { icon: typeof PlainFileIcon; className: string }
> = {
    image: { icon: ImageIcon, className: 'text-emerald-500' },
    video: { icon: FilmIcon, className: 'text-rose-500' },
    audio: { icon: MusicIcon, className: 'text-fuchsia-500' },
    archive: { icon: FileZipIcon, className: 'text-amber-500' },
    code: { icon: CodeIcon, className: 'text-sky-500' },
    config: { icon: BrowserCodeSimpleIcon, className: 'text-default-500' },
    document: { icon: MemoIcon, className: 'text-red-500' },
    spreadsheet: { icon: ChartColumnIcon, className: 'text-green-600 dark:text-green-500' },
    presentation: { icon: PresentationScreenIcon, className: 'text-orange-500' },
    text: { icon: FileTextIcon, className: 'text-default-500' },
    unknown: { icon: PlainFileIcon, className: 'text-default-400' },
}

export default function FileIcon({
    entry,
    size = 'md',
}: {
    entry: Entry
    size?: 'sm' | 'md' | 'lg'
}) {
    const sizeClass = ICON_SIZE_MAP[size]
    const type = getFileType(entry)
    if (type === 'folder') {
        return (
            <FolderIcon
                variant="filled"
                aria-hidden={true}
                className={`${sizeClass} shrink-0 text-sky-500 dark:text-sky-400`}
            />
        )
    }
    const { icon: Icon, className } = KIND[type]
    return (
        <Icon
            variant="duotone"
            aria-hidden={true}
            className={`${sizeClass} shrink-0 ${className}`}
        />
    )
}
