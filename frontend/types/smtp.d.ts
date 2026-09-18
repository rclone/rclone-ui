// Mirrors src-shared/src/notifications/smtp.rs: the mail server every email notification goes
// through, kept in notifications/smtp.json by the server. Pages see the view, never the file.

export type SmtpEncryption = 'starttls' | 'tls' | 'none'

/** `smtp_get`: everything but the password, and whether one is saved. An empty host is "not set up". */
export interface SmtpView {
    host: string
    port: number
    encryption: SmtpEncryption
    username: string
    hasPassword: boolean
    fromAddress: string
    fromName: string
}

/** `smtp_set`: `password: null` keeps the saved one; an empty host clears everything. */
export interface SmtpInput {
    host: string
    port: number
    encryption: SmtpEncryption
    username: string
    password: string | null
    fromAddress: string
    fromName: string
}
