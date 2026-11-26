import { t } from '@lingui/core/macro'
import { useEffect, useState } from 'react'
import { formatBytes } from '../../../../lib/format'

export interface PreviewBytes {
    buffer: ArrayBuffer | null
    isLoading: boolean
    error: string | null
    progress: number | null
    truncated: boolean
}

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

export function readFor(read: ReadOf, url: string | null): PreviewBytes {
    return url !== null && read.url === url ? read : LOADING
}

function tooLargeMessage(maxBytes: number): string {
    const max = formatBytes(maxBytes)
    return t`The file is larger than the limit for previews (${max}).`
}

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
