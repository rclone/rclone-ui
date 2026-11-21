import { cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Cloud as CloudIcon } from '@zappicon/react'
import { useState } from 'react'

// The logos that are drawn in white only. They wouldn't show on the light theme, so they are
// inverted there.
const WHITE_ONLY = new Set([
    'alias',
    'archive',
    'cache',
    'chunker',
    'combine',
    'compress',
    'crypt',
    'hasher',
    'internetarchive',
    'local',
    'memory',
    'pixeldrain',
    'sia',
    'union',
])

/**
 * A backend's logo, looked up by its rclone type (public/icons/backends/<type>.png). A type with
 * no logo, or no type at all (a remote that isn't loaded yet), shows a plain cloud instead.
 */
export default function BackendIcon({
    type,
    alt = '',
    className,
}: {
    type: string | undefined
    alt?: string
    className?: string
}) {
    const [missing, setMissing] = useState<string | null>(null)
    if (!type || missing === type) {
        return (
            <CloudIcon
                role={alt ? 'img' : undefined}
                aria-hidden={!alt}
                aria-label={alt || undefined}
                className={cn('text-default-500', className)}
            />
        )
    }
    return (
        <img
            src={`/icons/backends/${encodeURIComponent(type)}.png`}
            alt={alt}
            className={cn(
                'object-contain',
                WHITE_ONLY.has(type) && 'invert dark:invert-0',
                className
            )}
            onError={() => setMissing(type)}
        />
    )
}

const TILE_SIZES = {
    md: 'size-7 rounded-lg [&>*]:size-4',
    lg: 'size-9 rounded-[10px] [&>*]:size-5.5',
    xl: 'size-12 rounded-[14px] [&>*]:size-7',
    '2xl': 'size-16 rounded-[18px] [&>*]:size-10',
} as const

/** A backend's logo on a tile. The tile has the sizes of IconTile, so the two line up. */
export function BackendTile({
    type,
    alt,
    size = 'xl',
    className,
}: {
    type: string | undefined
    alt?: string
    size?: keyof typeof TILE_SIZES
    className?: string
}) {
    return (
        <span
            className={cn(
                'grid shrink-0 place-items-center bg-white dark:bg-default-100',
                'shadow-[0_0_0_1px_rgb(0_0_0/0.07),0_1px_2px_rgb(0_0_0/0.06)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.08),inset_0_1px_0_rgb(255_255_255/0.06)]',
                TILE_SIZES[size],
                className
            )}
        >
            <BackendIcon type={type} alt={alt} />
        </span>
    )
}

/**
 * The display names of the well-known backends, by rclone type. The names of products and of
 * rclone's own backends are not translated. Only the names that describe the backend are.
 */
const LABELS: Record<string, string> = {
    alias: 'Alias',
    azureblob: 'Azure Blob',
    azurefiles: 'Azure Files',
    b2: 'Backblaze B2',
    box: 'Box',
    cache: 'Cache',
    chunker: 'Chunker',
    combine: 'Combine',
    compress: 'Compress',
    crypt: t({ message: 'Encrypted', comment: "The name of rclone's crypt backend." }),
    drive: 'Google Drive',
    dropbox: 'Dropbox',
    fichier: '1Fichier',
    filen: 'Filen',
    ftp: 'FTP',
    'google cloud storage': 'Google Cloud Storage',
    'google photos': 'Google Photos',
    hasher: 'Hasher',
    hdfs: 'HDFS',
    hidrive: 'HiDrive',
    http: 'HTTP',
    iclouddrive: 'iCloud Drive',
    internetarchive: 'Internet Archive',
    jottacloud: 'Jottacloud',
    koofr: 'Koofr',
    local: t`Local disk`,
    mailru: 'Mail.ru Cloud',
    mega: 'MEGA',
    memory: t({
        message: 'Memory',
        comment: "The name of rclone's memory backend, which keeps files in RAM.",
    }),
    netstorage: 'Akamai NetStorage',
    onedrive: 'OneDrive',
    opendrive: 'OpenDrive',
    oracleobjectstorage: 'Oracle Object Storage',
    pcloud: 'pCloud',
    pikpak: 'PikPak',
    pixeldrain: 'Pixeldrain',
    premiumizeme: 'Premiumize.me',
    protondrive: 'Proton Drive',
    putio: 'put.io',
    qingstor: 'QingStor',
    s3: 'S3',
    seafile: 'Seafile',
    sftp: 'SFTP',
    sharefile: 'ShareFile',
    sia: 'Sia',
    smb: 'SMB',
    storj: 'Storj',
    sugarsync: 'SugarSync',
    swift: 'OpenStack Swift',
    union: 'Union',
    webdav: 'WebDAV',
    yandex: 'Yandex Disk',
    zoho: 'Zoho WorkDrive',
}

export function backendLabel(type: string | undefined): string {
    if (!type) return ''
    return LABELS[type] ?? type
}
