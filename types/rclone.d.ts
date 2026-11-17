export interface BackendOption {
    Name: string
    FieldName: string
    Help: string
    Provider?: string
    Default: any
    Value: any
    Examples?: Array<{ Value: string; Help: string }>
    Hide: number
    Required: boolean
    IsPassword: boolean
    NoPrefix: boolean
    Advanced: boolean
    Exclusive: boolean
    Sensitive: boolean
    DefaultStr: string
    ValueStr: string
    Type: string
}

export type FlagValue = string | number | boolean | string[] | null

// Response shape of the rclone RC `operations/fsinfo` endpoint. The SDK types `Features` only as
// an open `{ [k: string]: boolean }` map; this names the keys we actually gate on. Keys are the
// PascalCase names rclone emits from `Features.Enabled()` (fs/features.go).
export interface RcloneFeatures {
    About?: boolean
    Purge?: boolean
    CleanUp?: boolean
    PublicLink?: boolean
    CanHaveEmptyDirectories?: boolean
    [key: string]: boolean | undefined
}

export interface RcloneFsInfo {
    Name?: string
    Root?: string
    String?: string
    Precision?: number
    Hashes?: string[]
    Features?: RcloneFeatures
}
