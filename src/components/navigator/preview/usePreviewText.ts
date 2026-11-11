import { useMemo } from 'react'
import usePreviewBytes from './usePreviewBytes'

const decoder = new TextDecoder('utf-8')

/**
 * Fetches up to `maxBytes` of the file to preview and decodes them as UTF-8 for the text viewer.
 * A file that was cut short (`truncated`) ends at its last complete line.
 */
export default function usePreviewText(
    url: string | null,
    { maxBytes }: { maxBytes?: number } = {}
) {
    const { buffer, isLoading, error, progress, truncated } = usePreviewBytes(url, { maxBytes })
    const text = useMemo(() => {
        if (!buffer) return null
        const decoded = decoder.decode(buffer)
        if (!truncated) return decoded
        // The cut can fall anywhere, even inside a character, so end at the last complete line.
        const end = decoded.lastIndexOf('\n')
        return end === -1 ? decoded : decoded.slice(0, end + 1)
    }, [buffer, truncated])
    return { text, isLoading, error, progress, truncated }
}
