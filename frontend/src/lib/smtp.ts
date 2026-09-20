import { useQuery } from '@tanstack/react-query'
import { rpc } from '@/server/rpc'

// Mirrors src/notifications/smtp.rs: the mail server every email notification goes
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

// The SMTP settings screen and the Email notification target both read the same view; only
// the screen writes. The file behind it is the server's (src/notifications/smtp.rs), read at
// the moment of sending by whatever dispatches.

export const SMTP_QUERY_KEY = ['smtp'] as const

export async function getSmtpSettings(): Promise<SmtpView> {
    return await rpc<SmtpView>('smtp_get')
}

/** Throws with the server's own sentence (a port out of range, a from address that is none). */
export async function saveSmtpSettings(settings: SmtpInput): Promise<SmtpView> {
    return await rpc<SmtpView>('smtp_set', { settings })
}

/** The synthetic test mail to one address; throws with the delivery error. */
export async function sendSmtpTest(to: string): Promise<void> {
    await rpc('smtp_send_test', { to })
}

export function useSmtpSettings() {
    return useQuery({ queryKey: SMTP_QUERY_KEY, queryFn: getSmtpSettings })
}

/** A saved host is what makes an email target deliverable. */
export function isSmtpConfigured(view: SmtpView | undefined): boolean {
    return !!view?.host
}
