import {
    BoxSimple as BoxSimpleIcon,
    Film as FilmIcon,
    FolderConnection as FolderConnectionIcon,
    GlobeSimple as GlobeSimpleIcon,
    HardDrive as HardDriveIcon,
    LockSimple as LockSimpleIcon,
    type Page as PageIcon,
    Shield as ShieldIcon,
    TerminalSquare as TerminalSquareIcon,
    TowerBroadcast as TowerBroadcastIcon,
} from '@zappicon/react'

// The protocols that a folder can be served over: how each is written, and its icon. The Serve
// page's choices, its running serves and the Wizard's share step show them the same way.

export const PROTOCOL: Record<string, { name: string; icon: typeof PageIcon }> = {
    http: { name: 'HTTP', icon: GlobeSimpleIcon },
    webdav: { name: 'WebDAV', icon: FolderConnectionIcon },
    ftp: { name: 'FTP', icon: TerminalSquareIcon },
    sftp: { name: 'SFTP', icon: LockSimpleIcon },
    dlna: { name: 'DLNA', icon: FilmIcon },
    s3: { name: 'S3', icon: BoxSimpleIcon },
    nfs: { name: 'NFS', icon: HardDriveIcon },
    restic: { name: 'Restic', icon: ShieldIcon },
}

export function protocolName(type: string): string {
    return PROTOCOL[type]?.name ?? type.toUpperCase()
}

/** A protocol's icon. One that this list doesn't have gets the Serve window's. */
export function protocolIcon(type: string): typeof PageIcon {
    return PROTOCOL[type]?.icon ?? TowerBroadcastIcon
}
