import { useMemo } from 'react'
import usePreviewBytes from './usePreviewBytes'

// Reused across renders; UTF-8, non-fatal (invalid bytes become U+FFFD rather than throwing).
const decoder = new TextDecoder('utf-8')

/**
 * Fetches a preview target's bytes via the native (Tauri) HTTP client — same path as
 * the binary viewers, so it works for remote hosts without hitting the webview CORS
 * block — and decodes them to a UTF-8 string for the code/text viewer.
 */
export default function usePreviewText(url: string, authHeader?: string) {
    const { buffer, isLoading, error, progress } = usePreviewBytes(url, authHeader)
    const text = useMemo(() => (buffer ? decoder.decode(buffer) : null), [buffer])
    return { text, isLoading, error, progress }
}
