import { useMemo } from 'react'
import usePreviewBytes from './usePreviewBytes'

const decoder = new TextDecoder('utf-8')

export default function usePreviewText(
    url: string | null,
    { maxBytes }: { maxBytes?: number } = {}
) {
    const { buffer, isLoading, error, progress, truncated } = usePreviewBytes(url, { maxBytes })
    const text = useMemo(() => {
        if (!buffer) return null
        const decoded = decoder.decode(buffer)
        if (!truncated) return decoded
        const end = decoded.lastIndexOf('\n')
        return end === -1 ? decoded : decoded.slice(0, end + 1)
    }, [buffer, truncated])
    return { text, isLoading, error, progress, truncated }
}
