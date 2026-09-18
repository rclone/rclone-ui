import { useQuery } from '@tanstack/react-query'
import type { SmtpInput, SmtpView } from '../types/smtp'
import { rpc } from './api/rpc'

// The SMTP settings screen and the Email notification target both read the same view; only
// the screen writes. The file behind it is the server's (src-shared/src/notifications/smtp.rs),
// read at send time by whatever dispatches, the headless runner included.

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
