export interface ConfigFile {
    id: string | undefined
    label: string
    sync: string | undefined
    isEncrypted: boolean
    pass: string | undefined
    passCommand: string | undefined
}
