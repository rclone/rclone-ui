// Previews are fetched through the server's rc proxy (same origin, session cookie), which
// injects the daemon's credentials, so CORS never applies and the page holds no password.

import { useEffect, useState } from 'react'

export interface PreviewBytes {
    buffer: ArrayBuffer | null
    isLoading: boolean
    error: string | null
    // Download progress in 0..1, or null when the total size is unknown (no Content-Length).
    progress: number | null
}

/**
 * Downloads a preview target's bytes via the native (Tauri) HTTP client and hands
 * back an ArrayBuffer. Fetching the bytes ourselves — instead of letting a viewer
 * load by URL — avoids the webview CORS block against the rclone serve origin, so
 * any viewer that accepts a buffer can render local and remote files alike.
 *
 * The body is read as a stream so `progress` can track bytes-received / Content-Length
 * for a download progress bar; it stays null when the server sends no Content-Length.
 */
export default function usePreviewBytes(url: string, _authHeader?: string): PreviewBytes {
    const [state, setState] = useState<PreviewBytes>({
        buffer: null,
        isLoading: true,
        error: null,
        progress: null,
    })

    useEffect(() => {
        setState({ buffer: null, isLoading: true, error: null, progress: null })

        const abortController = new AbortController()
        let cancelled = false

        const run = async () => {
            try {
                const res = await fetch(url, {
                    credentials: 'same-origin',
                    signal: abortController.signal,
                })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)

                const totalHeader = res.headers.get('content-length')
                const total = totalHeader ? Number.parseInt(totalHeader, 10) : 0

                // No streamable body: fall back to reading the buffer directly.
                if (!res.body) {
                    const buffer = await res.arrayBuffer()
                    if (!cancelled) {
                        setState({ buffer, isLoading: false, error: null, progress: 1 })
                    }
                    return
                }

                const reader = res.body.getReader()
                const chunks: Uint8Array[] = []
                let received = 0
                let lastPercent = -1

                let result = await reader.read()
                while (!result.done) {
                    const chunk = result.value
                    chunks.push(chunk)
                    received += chunk.byteLength
                    // Throttle to whole-percent changes so we don't re-render per chunk.
                    if (total > 0 && !cancelled) {
                        const percent = Math.floor(Math.min(received / total, 1) * 100)
                        if (percent !== lastPercent) {
                            lastPercent = percent
                            setState((s) => ({ ...s, progress: percent / 100 }))
                        }
                    }
                    result = await reader.read()
                }

                const merged = new Uint8Array(received)
                let offset = 0
                for (const chunk of chunks) {
                    merged.set(chunk, offset)
                    offset += chunk.byteLength
                }
                if (!cancelled) {
                    setState({ buffer: merged.buffer, isLoading: false, error: null, progress: 1 })
                }
            } catch (err) {
                if (cancelled || abortController.signal.aborted) return
                setState({
                    buffer: null,
                    isLoading: false,
                    error: (err as Error).message,
                    progress: null,
                })
            }
        }

        run()

        return () => {
            cancelled = true
            abortController.abort()
        }
    }, [url])

    return state
}
