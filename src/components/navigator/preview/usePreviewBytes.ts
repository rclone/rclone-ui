// Previews are fetched from the core's signed media URLs (media.ts). The signature in the URL is
// the only credential, so the page holds none of its own. The media server allows the app's
// pages through CORS.

import { t } from '@lingui/core/macro'
import { useEffect, useState } from 'react'
import { formatBytes } from '../../../../lib/format'

export interface PreviewBytes {
    buffer: ArrayBuffer | null
    isLoading: boolean
    error: string | null
    // Download progress from 0 to 1, or null when the total size is unknown (no Content-Length).
    progress: number | null
    /** The file is longer than `maxBytes`, so the buffer holds only its start. */
    truncated: boolean
}

/**
 * Reads up to `max` bytes of a stream into one buffer, and calls `onProgress` with the number of
 * bytes read after each chunk. `done` is true when the stream ended within `max`. When it isn't,
 * the caller stops the download.
 */
export async function readAtMost(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    max: number,
    onProgress?: (received: number) => void
): Promise<{ bytes: Uint8Array; done: boolean }> {
    const chunks: Uint8Array[] = []
    let received = 0
    let result = await reader.read()
    while (!result.done) {
        const room = max - received
        if (result.value.byteLength > room) {
            // This chunk goes past `max`, so keep its start and stop reading.
            chunks.push(result.value.subarray(0, room))
            received = max
            break
        }
        chunks.push(result.value)
        received += result.value.byteLength
        onProgress?.(received)
        result = await reader.read()
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return { bytes, done: !!result.done }
}

const LOADING: PreviewBytes = {
    buffer: null,
    isLoading: true,
    error: null,
    progress: null,
    truncated: false,
}

export type ReadOf = PreviewBytes & { url: string | null }

/**
 * Returns the read for `url`, or the loading state while the stored read belongs to another URL.
 * The effect that starts a new read runs after the render that requested it, and that render
 * must not pass the previous file's bytes to a viewer as if they were the new file's.
 */
export function readFor(read: ReadOf, url: string | null): PreviewBytes {
    return url !== null && read.url === url ? read : LOADING
}

function tooLargeMessage(maxBytes: number): string {
    const max = formatBytes(maxBytes)
    return t`The file is larger than the limit for previews (${max}).`
}

/**
 * Downloads the bytes of the file to preview and returns them as an ArrayBuffer, so any viewer
 * that accepts a buffer can render local and remote files alike. `maxBytes` keeps only the start
 * of the file, such as the first part of a large log for the text viewer. The download stops
 * there and `truncated` is set. With `whole` (for documents, which no viewer can open when cut
 * short), a file larger than `maxBytes` is an error instead. While there is no URL yet (because
 * it is still being signed), the state is loading.
 *
 * The body is read as a stream so that `progress` can follow the bytes received.
 */
export default function usePreviewBytes(
    url: string | null,
    {
        maxBytes = Number.POSITIVE_INFINITY,
        whole = false,
    }: { maxBytes?: number; whole?: boolean } = {}
): PreviewBytes {
    const [read, setRead] = useState<ReadOf>({ ...LOADING, url: null })

    useEffect(() => {
        if (url === null) return
        setRead({ ...LOADING, url })

        const abortController = new AbortController()
        let cancelled = false
        const tooLarge = () => {
            abortController.abort()
            setRead({ ...LOADING, isLoading: false, error: tooLargeMessage(maxBytes), url })
        }

        const run = async () => {
            try {
                const res = await fetch(url, {
                    credentials: 'same-origin',
                    signal: abortController.signal,
                })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)

                const totalHeader = res.headers.get('content-length')
                const length = totalHeader ? Number.parseInt(totalHeader, 10) : 0
                if (whole && length > maxBytes) {
                    if (!cancelled) tooLarge()
                    return
                }
                const total = Math.min(length, maxBytes)

                // No streamable body: fall back to reading the buffer directly.
                if (!res.body) {
                    const all = await res.arrayBuffer()
                    const truncated = all.byteLength > maxBytes
                    if (cancelled) return
                    if (whole && truncated) {
                        tooLarge()
                        return
                    }
                    setRead({
                        buffer: truncated ? all.slice(0, maxBytes) : all,
                        isLoading: false,
                        error: null,
                        progress: 1,
                        truncated,
                        url,
                    })
                    return
                }

                let lastPercent = -1
                const { bytes, done } = await readAtMost(
                    res.body.getReader(),
                    maxBytes,
                    (received) => {
                        // Throttle to whole-percent changes so we don't re-render per chunk.
                        if (total <= 0 || cancelled) return
                        const percent = Math.floor(Math.min(received / total, 1) * 100)
                        if (percent !== lastPercent) {
                            lastPercent = percent
                            setRead((s) => ({ ...s, progress: percent / 100 }))
                        }
                    }
                )
                if (cancelled) return
                if (whole && !done) {
                    tooLarge()
                    return
                }
                // Only the start is kept, so stop downloading the rest of the file.
                if (!done) abortController.abort()
                setRead({
                    buffer: bytes.buffer as ArrayBuffer,
                    isLoading: false,
                    error: null,
                    progress: 1,
                    truncated: !done,
                    url,
                })
            } catch (err) {
                if (cancelled || abortController.signal.aborted) return
                setRead({
                    buffer: null,
                    isLoading: false,
                    error: (err as Error).message,
                    progress: null,
                    truncated: false,
                    url,
                })
            }
        }

        run()

        return () => {
            cancelled = true
            abortController.abort()
        }
    }, [url, maxBytes, whole])

    return readFor(read, url)
}
